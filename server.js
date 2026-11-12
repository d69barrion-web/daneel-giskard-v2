
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
    fields: 3,
    parts: 8,
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

function getFirestoreDB() {
  const app = getFirebaseAdmin();
  return admin.firestore(app);
}

async function createPendingReferenceImage({
  uid,
  responseId,
  callId,
  image
}) {
  if (
    !uid ||
    !responseId ||
    !callId ||
    !image?.imageId ||
    !image?.conversationId
  ) {
    throw new Error(
      "Incomplete reference image request."
    );
  }

  const db = getFirestoreDB();

  const pendingRef = db
    .collection("pendingReferenceImages")
    .doc();

  const now = Date.now();
  const expiresAt = now + (5 * 60 * 1000);

  await pendingRef.set({
    uid,
    responseId,
    callId,

    imageId: image.imageId,
    conversationId: image.conversationId,

    createdAt:
      admin.firestore.Timestamp.fromMillis(now),

    expiresAt:
      admin.firestore.Timestamp.fromMillis(expiresAt),
    
      status: "pending",
      used: false
  });

  return pendingRef.id;
}

async function claimPendingReferenceImage({
  pendingId,
  uid
}) {
  if (!pendingId || !uid) {
    throw new Error(
      "Pending request ID and user UID are required."
    );
  }

  const db = getFirestoreDB();

  const pendingRef = db
    .collection("pendingReferenceImages")
    .doc(pendingId);

  return await db.runTransaction(async transaction => {

    const snapshot = await transaction.get(pendingRef);

    if (!snapshot.exists) {
      throw new Error(
        "Pending reference image request not found."
      );
    }

    const pending = snapshot.data();
    const now = Date.now();

    if (pending.uid !== uid) {
      throw new Error(
        "Unauthorized reference image request."
      );
    }

    if (
      !pending.expiresAt ||
      pending.expiresAt.toMillis() <= now
    ) {
      throw new Error(
        "Reference image request has expired."
      );
    }

    if (pending.used === true) {
      throw new Error(
        "Reference image request was already used."
      );
    }

    if (pending.status !== "pending") {
  throw new Error("Reference image request is not available.");
    }

    transaction.update(pendingRef, {
      status: "processing",
      processingAt:
        admin.firestore.Timestamp.fromMillis(now)
    });

    return pending;
  });
}

async function completePendingReferenceImage({
  pendingId,
  uid
}) {
  const db = getFirestoreDB();

  const pendingRef = db
    .collection("pendingReferenceImages")
    .doc(pendingId);

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(pendingRef);

    if (!snapshot.exists) {
      throw new Error("Pending request not found.");
    }

    const pending = snapshot.data();

    if (
      pending.uid !== uid ||
      pending.status !== "processing" ||
      pending.used === true
    ) {
      throw new Error("Invalid pending request state.");
    }

    transaction.update(pendingRef, {
      status: "used",
      used: true,
      completedAt:
        admin.firestore.Timestamp.now()
    });
  });
}

async function releasePendingReferenceImage({
  pendingId,
  uid
}) {
  const db = getFirestoreDB();

  const pendingRef = db
    .collection("pendingReferenceImages")
    .doc(pendingId);

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(pendingRef);

    if (!snapshot.exists) return;

    const pending = snapshot.data();

    if (
      pending.uid !== uid ||
      pending.status !== "processing" ||
      pending.used === true
    ) {
      return;
    }

    if (
      pending.expiresAt &&
      pending.expiresAt.toMillis() <= Date.now()
    ) {
      transaction.update(pendingRef, {
        status: "expired"
      });
      return;
    }

    transaction.update(pendingRef, {
      status: "pending",
      processingAt: null
    });
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

async function verifyReferenceImageOwnership({
  uid,
  conversationId,
  imageId
}) {
  if (
    !uid ||
    !conversationId ||
    !imageId
  ) {
    throw new Error(
      "Incomplete image ownership verification."
    );
  }

  const conversationRef =
    getUserConversationsCollection(uid)
      .doc(conversationId);

  const snapshot = await conversationRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Reference image conversation not found."
    );
  }

  const conversation = snapshot.data();

  if (!Array.isArray(conversation.messages)) {
    throw new Error(
      "Conversation messages are unavailable."
    );
  }

  const imageExists = conversation.messages.some(
    message =>
      Array.isArray(message.images) &&
      message.images.some(
        image => image && image.id === imageId
      )
  );

  if (!imageExists) {
    throw new Error(
      "Reference image does not belong to this user."
    );
  }

  return true;
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

IMAGE GENERATION RULES:

You have access to an image generation tool.
Decide whether to use it based on the user's
actual intention and the context of the conversation.

Use the image generation tool when:

- The user clearly asks you to create, generate,
  draw, design, or illustrate a new image.
- The user requests a visual artwork or picture
  that does not yet exist.
- The user clearly asks you to create a new image
  based on an uploaded image or description.

Do NOT use the image generation tool when:

- The user is merely asking questions about images.
- The user is discussing image generation or its
  capabilities without requesting an image.
- The user asks you to describe, identify, interpret,
  or analyze an uploaded image.
- The user is asking for an explanation or advice
  that can be answered with text.

When the user's intention is ambiguous,
ask a clarifying question before generating.

When generating an image:

- Follow the user's requested subject, style,
  composition, setting, and other visual details.
- Preserve important details from the conversation
  when they are relevant to the requested image.
- Do not claim that an image was generated until
  the backend confirms successful execution.
- After successful generation, respond naturally
  and briefly acknowledge the result.

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
  },

  {
    type: "function",

    name: "generate_image",

    description:
      "Generate a new original image when the user clearly requests an image, picture, drawing, illustration, or visual artwork. Use this function only when the user's actual intention is to create a new image. Do not use it when the user is merely discussing images, asking questions about image generation, or requesting analysis or description of an uploaded image. If the request is ambiguous, ask for clarification instead.",

    strict: true,

    parameters: {
      type: "object",

      properties: {
        prompt: {
          type: "string",

          description:
            "A detailed visual description of the image to generate. Include the subject, style, composition, setting, colors, mood, and other visual details relevant to the user's request."
        }
      },

      required: ["prompt"],

      additionalProperties: false
    }
  },

  
{
  type: "function",

  name: "request_reference_image",

  description:
    "Retrieve a previously uploaded or generated image from the user's conversation history. Use this when the user explicitly refers to an earlier image and wants to view, analyze, compare, or use it as a reference for editing. Select the exact image ID from the available image catalog. Never invent an image ID.",

  strict: true,

  parameters: {
    type: "object",

    properties: {
      imageId: {
        type: "string",
        description:
          "The exact imageId of the historical image selected from the available image catalog."
      }
    },

    required: ["imageId"],

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
  user,
  generatedImages = []
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

    case "generate_image": {
      const prompt =
        typeof args.prompt === "string"
          ? args.prompt.trim()
          : "";

      if (!prompt) {
        throw new Error("An image prompt is required.");
      }

      if (prompt.length > 10000) {
        throw new Error("Image prompt is too long.");
      }

      const image = await generateImage(prompt);

      generatedImages.push({
        data: image.data,
        mimeType: image.mimeType,
        prompt
      });

      return {
        generated: true,
        message: "Image generated successfully."
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
  images = [],
  imageCatalog = []
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

const generatedImages = [];

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
    
    // Handle historical image retrieval separately.
    // The browser must retrieve the actual image Blob.

    const referenceCall = calls.find(
      call => call.name === "request_reference_image"
    );

    if (referenceCall) {

      if (calls.length !== 1) {
        throw new Error(
          "Historical image retrieval must run separately."
        );
      }

      let args;

      try {
        args = JSON.parse(referenceCall.arguments);
      } catch {
        throw new Error(
          "Invalid historical image request."
        );
      }

      if (
        !args ||
        typeof args.imageId !== "string" ||
        !args.imageId.trim()
      ) {
        throw new Error(
          "A valid image ID is required."
        );
      }

      const selectedImage = imageCatalog.find(
        image => image.imageId === args.imageId
      );

      if (!selectedImage) {
        throw new Error(
          "The requested image is not in the available catalog."
        );
      }

      const pendingId = await createPendingReferenceImage({
  uid: user.uid,
  responseId: response.id,
  callId: referenceCall.call_id,
  image: selectedImage
});

return {
  pendingReferenceImage: {
    pendingId,
    image: {
      imageId: selectedImage.imageId,
      conversationId: selectedImage.conversationId,
      conversationTitle: selectedImage.conversationTitle,
      name: selectedImage.name,
      mimeType: selectedImage.mimeType,
      size: selectedImage.size
    }
  }
};
    }


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
              user,
              generatedImages
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
  toolCalls: totalToolCalls,
  generatedImages
};

}

async function continueDaneelWithReference({
  pending,
  imageFile,
  user
}) {
  if (!openai) {
    throw new Error(
      "OpenAI API key is not configured."
    );
  }

  const imageOutput = {
    type: "function_call_output",
    call_id: pending.callId,
    output: [
      {
        type: "input_text",
        text: "Here is the requested historical reference image."
      },
      {
        type: "input_image",
        image_url:
          `data:${imageFile.mimetype};base64,${imageFile.buffer.toString("base64")}`,
        detail: "auto"
      }
    ]
  };

  let response = await openai.responses.create(
    {
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      previous_response_id: pending.responseId,
      input: [imageOutput],
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

  const generatedImages = [];

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

    if (calls.some(
      call => call.name === "request_reference_image"
    )) {
      throw new Error(
        "A second historical image request requires a separate retrieval."
      );
    }

    if (calls.length === 0) {
      finished = true;
      break;
    }

    if (
      round === MAX_TOOL_ROUNDS ||
      totalToolCalls + calls.length > MAX_TOOL_CALLS
    ) {
      throw new Error(
        "Daneel reached its tool execution limit."
      );
    }

    const outputs = await Promise.all(
      calls.map(async call => {
        try {
          const args = JSON.parse(call.arguments);

          if (
            typeof args !== "object" ||
            args === null ||
            Array.isArray(args)
          ) {
            throw new Error("Invalid tool arguments.");
          }

          const result = await executeTool(
            call.name,
            args,
            user,
            generatedImages
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

  return {
    message:
      response.output_text?.trim() ||
      "Pasensya, wala akong maibigay na text response sa ngayon.",

    responseId: response.id,
    usage: response.usage || null,
    toolCalls: totalToolCalls,
    generatedImages
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
// 9.4 IMAGE GENERATION ENDPOINT
// ==========================================

async function generateImage(prompt) {

  const result = await openai.images.generate(
    {
      model: IMAGE_GENERATION_MODEL,
      prompt,
      n: 1
    },
    {
      signal: AbortSignal.timeout(180000)
    }
  );

  const imageBase64 =
    result.data?.[0]?.b64_json;

  if (
    typeof imageBase64 !== "string" ||
    !imageBase64
  ) {
    throw new Error(
      "OpenAI returned no generated image."
    );
  }

  return {
    data: imageBase64,
    mimeType: "image/png"
  };

}

app.post(
  "/images/generate",
  requireAuth,
  async (req, res) => {

    try {

      if (!openai) {
        return res.status(503).json({
          ok: false,
          error: "OpenAI API key is not configured."
        });
      }

      const prompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error: "An image prompt is required."
        });
      }

      if (prompt.length > 10000) {
        return res.status(413).json({
          ok: false,
          error: "Image prompt is too long."
        });
      }

      const image = await generateImage(prompt);

      return res.json({
  ok: true,
  image
});

    } catch (error) {

      console.error(
        "Image generation failed:",
        error.message
      );

      return res.status(502).json({
        ok: false,
        error: "Unable to generate the image."
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

      
      // Parse historical image catalog.

      let imageCatalog = req.body?.imageCatalog ?? [];

      if (typeof imageCatalog === "string") {
        try {
          imageCatalog = JSON.parse(imageCatalog);
        } catch {
          return res.status(400).json({
            ok: false,
            error: "Invalid image catalog format."
          });
        }
      }

      if (!Array.isArray(imageCatalog)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid image catalog."
        });
      }

      if (imageCatalog.length > 100) {
        return res.status(400).json({
          ok: false,
          error: "Too many images in catalog."
        });
      }

      const cleanImageCatalog = [];

      for (const image of imageCatalog) {

        if (
          !image ||
          typeof image !== "object" ||
          typeof image.imageId !== "string" ||
          !image.imageId.trim() ||
          typeof image.conversationId !== "string" ||
          typeof image.role !== "string" ||
          !["user", "assistant", "unknown"].includes(image.role) ||
          !Number.isInteger(image.messageIndex) ||
          image.messageIndex < 0 ||
          typeof image.mimeType !== "string" ||
          !image.mimeType.startsWith("image/") ||
          !Number.isFinite(image.size) ||
          image.size < 0
        ) {
          return res.status(400).json({
            ok: false,
            error: "Invalid image catalog entry."
          });
        }

        cleanImageCatalog.push({
          imageId: image.imageId.slice(0, 200),
          conversationId: image.conversationId.slice(0, 200),
          conversationTitle:
            typeof image.conversationTitle === "string"
              ? image.conversationTitle.slice(0, 200)
              : "Untitled conversation",
          messageIndex: image.messageIndex,
          role: image.role,
          name:
            typeof image.name === "string"
              ? image.name.slice(0, 200)
              : "Attached image",
          mimeType: image.mimeType.slice(0, 100),
          size: image.size,
          prompt:
            typeof image.prompt === "string"
              ? image.prompt.slice(0, 2000)
              : "",
          mode:
            typeof image.mode === "string"
              ? image.mode.slice(0, 50)
              : "unknown"
        });
      }

      console.log(
        "Historical image catalog received:",
        cleanImageCatalog.length
      );


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
  images: req.files || [],
  imageCatalog: cleanImageCatalog
});

      // Historical image retrieval handoff.

      if (result.pendingReferenceImage) {
        return res.json({
          ok: true,
          action: {
            type: "retrieve_reference_image"
          },
          pendingReferenceImage:
            result.pendingReferenceImage
        });
      }

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
       toolCalls: result.toolCalls,
       generatedImages: result.generatedImages || []
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

app.post(
  "/continue-reference-image",
  requireAuth,
  upload.single("referenceImage"),
  async (req, res) => {

    let pendingId = null;
    let claimed = false;
    let continuationSucceeded = false;

    try {

      const uid = req.user.uid;
      pendingId = req.body?.pendingId;

      // Validate pending ID.
      if (
        typeof pendingId !== "string" ||
        !/^[A-Za-z0-9]{1,128}$/.test(pendingId)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid pending request ID."
        });
      }

      // Validate uploaded image.
      const imageFile = req.file;

      if (
        !imageFile ||
        !Buffer.isBuffer(imageFile.buffer) ||
        imageFile.buffer.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Reference image is missing."
        });
      }

      if (
        !imageFile.mimetype ||
        !imageFile.mimetype.startsWith("image/")
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid reference image type."
        });
      }

      // Atomically claim the pending request.
      const pending = await claimPendingReferenceImage({
        pendingId,
        uid
      });

      claimed = true;

      // Verify that the image belongs to this user.
      await verifyReferenceImageOwnership({
        uid,
        conversationId: pending.conversationId,
        imageId: pending.imageId
      });

      // Verify that the pending request is complete.
      if (
        !pending.responseId ||
        !pending.callId ||
        !pending.imageId ||
        !pending.conversationId
      ) {
        throw new Error(
          "Incomplete pending reference image data."
        );
      }

      // Continue the original OpenAI response.
      const result = await continueDaneelWithReference({
        pending,
        imageFile,
        user: req.user
      });

      continuationSucceeded = true;

      // Mark the pending request as permanently used.
      await completePendingReferenceImage({
        pendingId,
        uid
      });

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
        toolCalls: result.toolCalls,
        generatedImages: result.generatedImages || []
      });

    } catch (error) {

      console.error(
        "Continue reference image failed:",
        error.message
      );

      // Release the request only if OpenAI continuation
      // did not successfully complete.
      if (claimed && !continuationSucceeded) {
        try {
          await releasePendingReferenceImage({
            pendingId,
            uid: req.user.uid
          });
        } catch (releaseError) {
          console.error(
            "Pending image release failed:",
            releaseError.message
          );
        }
      }

      return res.status(500).json({
        ok: false,
        error:
          "Unable to continue the reference image request."
      });

    }

  }
);

app.post(
  "/reference-image-test",
  requireAuth,
  upload.single("referenceImage"),
  async (req, res) => {

    try {

      const file = req.file;

      if (!file) {
        return res.status(400).json({
          ok: false,
          error: "No reference image received."
        });
      }

      if (
        !Buffer.isBuffer(file.buffer) ||
        file.buffer.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid image data."
        });
      }

      if (!file.mimetype.startsWith("image/")) {
        return res.status(400).json({
          ok: false,
          error: "Invalid image MIME type."
        });
      }

      return res.json({
        ok: true,
        message: "Reference image received successfully.",
        image: {
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          bufferReceived: true
        }
      });

    } catch (error) {

      console.error(
        "Reference image test failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Reference image test failed."
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
