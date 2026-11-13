
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import admin from "firebase-admin";

// ==========================================
// 1. BASIC CONFIGURATION
// ==========================================

const app = express();

const PORT = process.env.PORT || 3000;

const MODEL =
  process.env.OPENAI_MODEL || "gpt-5.4-mini";

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
  history
}) {

  if (!openai) {
    throw new Error(
      "OpenAI API key is not configured."
    );
  }

  const input = [
    ...history,
    {
      role: "user",
      content: message
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
// 10. MAIN CHAT ENDPOINT
// ==========================================

app.post(
  "/chat",
  requireAuth,
  async (req, res) => {

    try {

      const message = req.body?.message;

      const history = req.body?.history || [];

      if (
        typeof message !== "string" ||
        !message.trim()
      ) {
        return res.status(400).json({
          ok: false,
          error: "A valid message is required."
        });
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
        history: cleanHistory
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

