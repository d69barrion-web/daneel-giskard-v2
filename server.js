
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import admin from "firebase-admin";
import multer from "multer";

// ==========================================
// 1. BASIC CONFIGURATION
// ==========================================

const app = express();

const PORT = process.env.PORT || 3000;

const MODEL =
  process.env.OPENAI_MODEL || "gpt-5.4-mini";

const IMAGE_GENERATION_MODEL =
  "gpt-image-1.5";

const IMAGE_EDIT_MODEL =
  "gpt-image-2.5-flare-2026-09-08";

const MAX_TOOL_ROUNDS =
  Number(process.env.MAX_TOOL_ROUNDS || 6);

const MAX_TOOL_CALLS =
  Number(process.env.MAX_TOOL_CALLS || 12);

const MAX_MESSAGE_CHARS =
  Number(process.env.MAX_MESSAGE_CHARS || 100000);

const MAX_HISTORY_MESSAGES =
  Number(process.env.MAX_HISTORY_MESSAGES || 30);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
  : null;

// ==========================================
// IMAGE UPLOAD CONFIGURATION
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
    fields: 2,
    parts: 7,
    fieldSize: 2 * 1024 * 1024
  },

  fileFilter(req, file, callback) {

    if (!file.mimetype.startsWith("image/")) {
      return callback(
        new Error("Only image files are allowed.")
      );
    }

    callback(null, true);

  }

});

// ==========================================
// 2. CORS AND REQUEST CONFIGURATION
// ==========================================

const allowedOrigins = (
  process.env.CORS_ORIGINS || ""
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.includes("*")
      ) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin not allowed by CORS")
      );
    },
    credentials: true
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

// ==========================================
// 3. FIREBASE ADMIN INITIALIZATION
// ==========================================

function getFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const rawServiceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!rawServiceAccount) {
    throw new Error(
      "Firebase service account is not configured."
    );
  }

  const serviceAccount =
    JSON.parse(rawServiceAccount);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(
        /\\n/g,
        "\n"
      );
  }

  return admin.initializeApp({
    credential: admin.credential.cert(
      serviceAccount
    ),
    projectId:
      process.env.FIREBASE_PROJECT_ID ||
      serviceAccount.project_id
  });
}


// Firestore access helper.
// Gagamitin natin ito kapag naitatag na
// ang database collections at data structure.

function getFirestore() {
  getFirebaseAdmin();
  return admin.firestore();
}

// Get the authenticated user's conversations collection
function getUserConversationsCollection(uid) {

  if (!uid || typeof uid !== "string") {
    throw new Error("Invalid user UID.");
  }

  return getFirestore()
    .collection("users")
    .doc(uid)
    .collection("conversations");

}

// ==========================================
// 4. FIREBASE AUTHENTICATION MIDDLEWARE
// ==========================================

async function requireAuth(req, res, next) {
  try {
    const authorization =
      req.get("Authorization") || "";

    const match = authorization.match(
      /^Bearer\s+(.+)$/i
    );

    if (!match) {
      return res.status(401).json({
        ok: false,
        error: "Authentication token required."
      });
    }

    getFirebaseAdmin();

    const decodedToken =
      await admin.auth().verifyIdToken(
        match[1]
      );

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      emailVerified:
        decodedToken.email_verified === true,
      displayName: decodedToken.name || null
    };

    next();

  } catch (error) {
    console.error(
      "Authentication error:",
      error.message
    );

    return res.status(401).json({
      ok: false,
      error: "Invalid or expired authentication token."
    });
  }
}


// ==========================================
// 5. DANEEL SYSTEM INSTRUCTIONS
// ==========================================

const SYSTEM_PROMPT = `
You are Daneel Giskard — Ang Kaibigan ni Daniel.

You are an intelligent, honest, thoughtful,
and helpful AI assistant.

Your responsibilities include:

- Understand the user's actual intention.
- Give clear and useful explanations.
- Be honest about uncertainty and limitations.
- Do not invent facts, sources, or actions.
- Ask for clarification when necessary.
- Use available tools when they can materially
  improve the accuracy or completeness of an answer.
- Never claim that a tool was executed unless
  the backend actually executed it.

You may request available tools when needed.

The backend, not you, is responsible for
validating and executing tool requests.

Respond naturally in the language used by
the user, including Filipino or Taglish.
`;


// ==========================================
// 6. AVAILABLE AI TOOLS
// ==========================================

// Initial safe tool.
// We will add project-file tools, learning
// library tools, and other capabilities later.

const TOOL_DEFINITIONS = [
  {
    type: "function",

    name: "get_my_account_context",

    description:
      "Get the identity information of the currently authenticated user.",

    strict: true,

    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
];


// ==========================================
// 7. TOOL EXECUTION
// ==========================================

async function executeTool(
  toolName,
  args,
  user
) {
  switch (toolName) {

    case "get_my_account_context": {

      return {
        uid: user.uid,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName
      };

    }

    default:
      throw new Error(
        `Unknown or unauthorized tool: ${toolName}`
      );
  }
}


// ==========================================
// 8. OPENAI TOOL-CALLING ORCHESTRATOR
// ==========================================

async function runDaneel({
  user,
  message,
  history,
  images = []
}) {

  if (!openai) {
    throw new Error(
      "OpenAI API key is not configured."
    );
  }

  const userContent = [];

if (message.trim()) {
  userContent.push({
    type: "input_text",
    text: message
  });
}

images.forEach(file => {
  userContent.push({
    type: "input_image",
    image_url:
      `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
    detail: "auto"
  });
});

const input = [
  ...history,
  {
    role: "user",
    content: userContent
  }
];
  
  let response = await openai.responses.create(
    {
      model: MODEL,

      instructions: SYSTEM_PROMPT,

      input,

      tools: TOOL_DEFINITIONS,

      tool_choice: "auto",

      parallel_tool_calls: true,

      max_output_tokens: 4000
    },
    {
      signal: AbortSignal.timeout(120000)
    }
  );

  let totalToolCalls = 0;
  let finished = false;

  // AI may request tools multiple times.
  // The backend controls the maximum rounds.

  for (
    let round = 0;
    round <= MAX_TOOL_ROUNDS;
    round++
  ) {

    if (response.status !== "completed") {
      throw new Error(
        "OpenAI response did not complete: " +
        response.status
      );
    }

    const calls = response.output.filter(
      item => item.type === "function_call"
    );

    // No more tool requests:
    // AI has completed its response.

    if (calls.length === 0) {
      finished = true;
      break;
    }

    if (
      round === MAX_TOOL_ROUNDS ||
      totalToolCalls + calls.length >
        MAX_TOOL_CALLS
    ) {
      throw new Error(
        "Daneel reached its tool execution limit."
      );
    }

    // Execute requested tools.
    // Multiple independent calls may run together.

    const outputs = await Promise.all(
      calls.map(async call => {

        try {

          const args = JSON.parse(
            call.arguments
          );

          if (
            typeof args !== "object" ||
            args === null ||
            Array.isArray(args)
          ) {
            throw new Error(
              "Invalid tool arguments."
            );
          }

          const result = await executeTool(
            call.name,
            args,
            user
          );

          return {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              ok: true,
              result
            })
          };

        } catch (error) {

          return {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              ok: false,
              error: error.message
            })
          };

        }

      })
    );

    totalToolCalls += calls.length;

    // Send tool results back to the AI.
    // It may request more tools or produce
    // its final response.

    response = await openai.responses.create(
      {
        model: MODEL,

        instructions: SYSTEM_PROMPT,

        previous_response_id: response.id,

        input: outputs,

        tools: TOOL_DEFINITIONS,

        tool_choice: "auto",

        parallel_tool_calls: true,

        max_output_tokens: 4000
      },
      {
        signal: AbortSignal.timeout(120000)
      }
    );

  }

  if (!finished) {
    throw new Error(
      "Daneel could not finish within the tool limits."
    );
  }

  const finalMessage =
    response.output_text?.trim() ||
    "Pasensya, wala akong maibigay na text response sa ngayon.";

  return {
    message: finalMessage,
    responseId: response.id,
    usage: response.usage || null,
    toolCalls: totalToolCalls
  };

}


// ==========================================
// 9. HEALTH CHECK
// ==========================================

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    service: "Daneel Giskard v2",

    openaiConfigured:
      Boolean(process.env.OPENAI_API_KEY),

    firebaseConfigured:
      Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ),

    model: MODEL
  });

});

// ==========================================
// 9.1 GET USER CONVERSATIONS
// ==========================================

app.get(
  "/conversations",
  requireAuth,
  async (req, res) => {

    try {

      const snapshot =
        await getUserConversationsCollection(
          req.user.uid
        ).get();

      const conversations = snapshot.docs.map(
        doc => ({
          ...doc.data(),
          id: doc.id
        })
      );

      return res.json({
        ok: true,
        conversations
      });

    } catch (error) {

      console.error(
        "Load conversations failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to load conversations."
      });

    }

  }
);

// ==========================================
// 9.2 SAVE OR UPDATE A CONVERSATION
// ==========================================

app.put(
  "/conversations/:id",
  requireAuth,
  async (req, res) => {

    try {

      const conversationId = req.params.id;
      const body = req.body;

      // Validate conversation ID
      if (
        typeof conversationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation ID."
        });
      }

      // Validate request body
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation data."
        });
      }

      const { title, pinned, updatedAt, messages } = body;

      // Validate title
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 200
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation title."
        });
      }

      // Validate pinned
      if (typeof pinned !== "boolean") {
        return res.status(400).json({
          ok: false,
          error: "Invalid pinned value."
        });
      }

      // Validate updatedAt
      if (
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt) ||
        updatedAt < 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid updatedAt value."
        });
      }

      // Validate messages
      if (
        !Array.isArray(messages) ||
        messages.length > 500
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation messages."
        });
      }

      const cleanMessages = [];

      for (const item of messages) {

        if (
          !item ||
          typeof item !== "object" ||
          !["user", "assistant"].includes(item.role) ||
          typeof item.content !== "string" ||
          item.content.length > MAX_MESSAGE_CHARS
        ) {
          return res.status(400).json({
            ok: false,
            error: "Invalid conversation message."
          });
        }

        const cleanMessage = {
  role: item.role,
  content: item.content
};

if (Array.isArray(item.images)) {

  if (item.images.length > 5) {
    return res.status(400).json({
      ok: false,
      error: "Too many images in one message."
    });
  }

  cleanMessage.images = [];

  for (const image of item.images) {

    if (
      !image ||
      typeof image.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(image.id) ||
      typeof image.name !== "string" ||
      typeof image.mimeType !== "string" ||
      typeof image.size !== "number" ||
      !Number.isFinite(image.size) ||
      image.size < 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid image metadata."
      });
    }

    cleanMessage.images.push({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      size: image.size
    });
  }
}

cleanMessages.push(cleanMessage);

      }

      const conversationData = {
        title: title.trim(),
        pinned,
        updatedAt,
        messages: cleanMessages
      };

      // Keep the document below Firestore's 1 MiB limit.
      const dataSize = Buffer.byteLength(
        JSON.stringify(conversationData),
        "utf8"
      );

      if (dataSize > 900000) {
        return res.status(413).json({
          ok: false,
          error: "Conversation is too large to save."
        });
      }

      // Always use the authenticated user's collection.
      await getUserConversationsCollection(
        req.user.uid
      )
        .doc(conversationId)
        .set(conversationData);

      return res.json({
        ok: true,
        message: "Conversation saved.",
        id: conversationId
      });

    } catch (error) {

      console.error(
        "Save conversation failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to save conversation."
      });

    }

  }
);

// ==========================================
// 9.3 DELETE A CONVERSATION
// ==========================================

app.delete(
  "/conversations/:id",
  requireAuth,
  async (req, res) => {

    try {

      const conversationId = req.params.id;

      if (
        typeof conversationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation ID."
        });
      }

      await getUserConversationsCollection(
        req.user.uid
      )
        .doc(conversationId)
        .delete();

      return res.json({
        ok: true,
        message: "Conversation deleted.",
        id: conversationId
      });

    } catch (error) {

      console.error(
        "Delete conversation failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to delete conversation."
      });

    }

  }
);

// ==========================================
// 10. MAIN CHAT ENDPOINT
// ==========================================

app.post(
  "/chat",
  requireAuth,
  upload.array("images", 5),
  async (req, res) => {

    try {

      const message =
        typeof req.body?.message === "string"
        ? req.body.message
        : "";

      const hasImages =
         Array.isArray(req.files) &&
         req.files.length > 0;

       if (!message.trim() && !hasImages) {
         return res.status(400).json({
         ok: false,
         error: "A message or image is required."
         });
        }
      console.log("Uploaded images:", (req.files || []).map(file => ({
           name: file.originalname,
           type: file.mimetype,
           size: file.size,
      bufferReceived: Buffer.isBuffer(file.buffer)
      })));
      
      let history = req.body?.history ?? [];

       if (typeof history === "string") {
         try {
         history = JSON.parse(history);
         } catch {
         return res.status(400).json({
         ok: false,
         error: "Invalid conversation history format."
         });
        }
      }

      

      if (
        message.length > MAX_MESSAGE_CHARS
      ) {
        return res.status(413).json({
          ok: false,
          error: "Message exceeds the configured limit."
        });
      }

      if (!Array.isArray(history)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid conversation history."
        });
      }

      if (
        history.length > MAX_HISTORY_MESSAGES
      ) {
        return res.status(400).json({
          ok: false,
          error: "Too many history messages."
        });
      }

      const cleanHistory = history.map(item => {

        if (
          !item ||
          !["user", "assistant"].includes(item.role) ||
          typeof item.content !== "string" ||
          item.content.length > MAX_MESSAGE_CHARS
        ) {
          throw new Error(
            "Invalid conversation history item."
          );
        }

        return {
          role: item.role,
          content: item.content
        };

      });

      const result = await runDaneel({
        user: req.user,
        message: message.trim(),
        history: cleanHistory,
        images: req.files || []
      });

      // Consistent JSON response for the frontend.

      return res.json({
        ok: true,

        action: {
          type: "chat"
        },

        chat: {
          text: result.message
        },

        responseId: result.responseId,

        usage: result.usage,

        toolCalls: result.toolCalls
      });

    } catch (error) {

      console.error(
        "Chat request failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "An error occurred while processing your request."
      });

    }

  }
);


// ==========================================
// 11. GENERAL ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {

  console.error(
    "Server error:",
    error.message
  );

  const status =
    error.status ||
    (
      error.message ===
      "Origin not allowed by CORS"
        ? 403
        : 500
    );

  res.status(status).json({
    ok: false,
    error:
      status === 403
        ? "Request origin is not allowed."
        : "An unexpected server error occurred."
  });

});


// ==========================================
// 12. START SERVER
// ==========================================

app.listen(PORT, () => {

  console.log(
    `Daneel Giskard v2 running on port ${PORT}`
  );

});
