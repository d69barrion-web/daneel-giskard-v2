
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import admin from "firebase-admin";
import { randomUUID } from "node:crypto";

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
// PER-USER CREDITS AND BILLING
// ==========================================

// Each user's balance is stored at:
// users/{uid}/billing/credits
//
// The owner manually creates the document and sets
// startingCreditsPhp. If remainingCreditsPhp is absent,
// it is initialized from startingCreditsPhp exactly once.

function getUserCreditsRef(uid) {
  if (!uid || typeof uid !== "string") {
    throw new Error("Invalid user UID.");
  }

  return getFirestore()
    .collection("users")
    .doc(uid)
    .collection("billing")
    .doc("credits");
}

function billingError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function roundPhp(value) {
  // Keep six decimal places so very small API costs
  // are not rounded down to zero.
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

const CREDIT_LOCK_MS = 20 * 60 * 1000;

async function reserveUserCredits(uid, requestId) {
  const db = getFirestore();
  const ref = getUserCreditsRef(uid);
  const now = Date.now();

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      throw billingError(
        "Credits are not configured for this account. Please contact the administrator.",
        402
      );
    }

    const data = snapshot.data() || {};
    const starting = data.startingCreditsPhp;

    if (
      typeof starting !== "number" ||
      !Number.isFinite(starting) ||
      starting < 0
    ) {
      throw billingError(
        "The startingCreditsPhp value in the user's credits document is invalid.",
        500
      );
    }

    let remaining = data.remainingCreditsPhp;

    // Initialize the remaining balance only if it has
    // never been initialized. Never reset an existing balance.
    if (remaining === undefined || remaining === null) {
      remaining = starting;
    }

    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining)
    ) {
      throw billingError(
        "The remainingCreditsPhp value in the user's credits document is invalid.",
        500
      );
    }

    const totalSpent =
      typeof data.totalSpentPhp === "number" &&
      Number.isFinite(data.totalSpentPhp)
        ? data.totalSpentPhp
        : 0;

    const activeUntil =
      typeof data.activeRequestUntilMs === "number"
        ? data.activeRequestUntilMs
        : 0;

    if (
      data.activeRequestId &&
      activeUntil > now
    ) {
      throw billingError(
        "Another chat request is already being processed for this account. Please wait for it to finish.",
        409
      );
    }

    if (remaining <= 0) {
      throw billingError(
        "Your Daneel credits are used up. Please contact the administrator.",
        402
      );
    }

    transaction.set(ref, {
      startingCreditsPhp: starting,
      remainingCreditsPhp: roundPhp(remaining),
      totalSpentPhp: roundPhp(totalSpent),
      currency: "PHP",
      activeRequestId: requestId,
      activeRequestUntilMs: now + CREDIT_LOCK_MS,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(data.createdAt ? {} : {
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      })
    }, { merge: true });

    return {
      startingCreditsPhp: starting,
      remainingCreditsPhp: roundPhp(remaining)
    };
  });
}

async function releaseUserCreditsLock(uid, requestId) {
  const db = getFirestore();
  const ref = getUserCreditsRef(uid);

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) return;

    const data = snapshot.data() || {};

    // Never clear a lock owned by a newer request.
    if (data.activeRequestId !== requestId) return;

    transaction.set(ref, {
      activeRequestId: admin.firestore.FieldValue.delete(),
      activeRequestUntilMs: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function chargeUserCredits(uid, requestId, costPhp) {
  const db = getFirestore();
  const ref = getUserCreditsRef(uid);

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      throw billingError(
        "The user's credits document disappeared during billing.",
        500
      );
    }

    const data = snapshot.data() || {};

    if (data.activeRequestId !== requestId) {
      throw billingError(
        "The billing lock expired before the request could be charged. Please check the credits ledger.",
        409
      );
    }

    const currentRemaining = data.remainingCreditsPhp;
    const currentSpent =
      data.totalSpentPhp === undefined ||
      data.totalSpentPhp === null
        ? 0
        : data.totalSpentPhp;

    if (
      typeof currentRemaining !== "number" ||
      !Number.isFinite(currentRemaining) ||
      typeof currentSpent !== "number" ||
      !Number.isFinite(currentSpent)
    ) {
      throw billingError(
        "The user's remaining credits value is invalid.",
        500
      );
    }

    const nextRemaining = roundPhp(
      currentRemaining - costPhp
    );

    const nextSpent = roundPhp(
      currentSpent + costPhp
    );

    transaction.set(ref, {
      remainingCreditsPhp: nextRemaining,
      totalSpentPhp: nextSpent,
      lastInteractionCostPhp: roundPhp(costPhp),
      lastChargedAt: admin.firestore.FieldValue.serverTimestamp(),
      activeRequestId: admin.firestore.FieldValue.delete(),
      activeRequestUntilMs: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      remainingCreditsPhp: nextRemaining,
      totalSpentPhp: nextSpent
    };
  });
}

// Current GPT-5.4 mini standard API rates, USD per 1M tokens.
// Add a model entry here before enabling a different model
// in a future model-routing implementation.
const MODEL_PRICING_USD_PER_MILLION = {
  "gpt-5.4-mini": {
    input: 0.75,
    cachedInput: 0.075,
    output: 4.50
  }
};

function getBillingPricingKey(model) {
  // Recognize dated snapshots of GPT-5.4 mini.
  const datedMiniMatch = model.match(
    /^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}$/
  );

  if (datedMiniMatch) {
    return "gpt-5.4-mini";
  }

  // Exact model match for all other configured models.
  return model;
}

const USD_TO_PHP_RATE = Number(
  process.env.USD_TO_PHP_RATE
);

function calculateInteractionBilling(roundUsage) {
  if (
    !Number.isFinite(USD_TO_PHP_RATE) ||
    USD_TO_PHP_RATE <= 0
  ) {
    throw new Error("USD_TO_PHP_RATE must be a positive number.");
  }

  if (!Array.isArray(roundUsage) || roundUsage.length === 0) {
    throw new Error("OpenAI usage data is missing; billing cannot be calculated.");
  }

  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };

  let totalCostUsd = 0;

  const roundBreakdown = roundUsage.map(record => {
    const pricingKey = getBillingPricingKey(record.model);

const pricing =
  MODEL_PRICING_USD_PER_MILLION[pricingKey];

    if (!pricing) {
      throw new Error(
        `No billing rates are configured for model: ${record.model}`
      );
    }

    const usage = record.usage;

    if (
      !usage ||
      !Number.isFinite(usage.input_tokens) ||
      !Number.isFinite(usage.output_tokens)
    ) {
      throw new Error(
        `Usage data is incomplete for Responses API round ${record.round}.`
      );
    }

    const inputTokens = Math.max(0, usage.input_tokens);
    const cachedTokens = Math.min(
      inputTokens,
      Math.max(
        0,
        Number(usage.input_tokens_details?.cached_tokens || 0)
      )
    );
    const uncachedTokens = inputTokens - cachedTokens;
    const outputTokens = Math.max(0, usage.output_tokens);

    const costUsd =
      (
        uncachedTokens * pricing.input +
        cachedTokens * pricing.cachedInput +
        outputTokens * pricing.output
      ) / 1_000_000;

    totals.input_tokens += inputTokens;
    totals.cached_input_tokens += cachedTokens;
    totals.uncached_input_tokens += uncachedTokens;
    totals.output_tokens += outputTokens;
    totals.total_tokens += inputTokens + outputTokens;
    totalCostUsd += costUsd;

    return {
      round: record.round,
      model: record.model,
      inputTokens,
      cachedInputTokens: cachedTokens,
      uncachedInputTokens: uncachedTokens,
      outputTokens,
      costUsd,
      costPhp: roundPhp(costUsd * USD_TO_PHP_RATE)
    };
  });

  const costPhp = roundPhp(
    totalCostUsd * USD_TO_PHP_RATE
  );

  return {
    model: roundUsage[roundUsage.length - 1].model,
    rounds: roundUsage.length,
    costUsd: totalCostUsd,
    costPhp,
    usdToPhpRate: USD_TO_PHP_RATE,
    usage: totals,
    roundBreakdown
  };
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

  const roundUsage = [];

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

  roundUsage.push({
    round: 1,
    model: MODEL,
    usage: response.usage || null
  });

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

    roundUsage.push({
      round: round + 2,
      model: MODEL,
      usage: response.usage || null
    });

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
    roundUsage,
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

        if (item.billing !== undefined && item.billing !== null) {
          const billing = item.billing;

          const validNumber = value =>
            typeof value === "number" &&
            Number.isFinite(value);

          if (
            item.role !== "assistant" ||
            !billing ||
            typeof billing !== "object" ||
            Array.isArray(billing) ||
            !validNumber(billing.costPhp) ||
            !validNumber(billing.remainingCreditsPhp) ||
            !validNumber(billing.costUsd) ||
            !validNumber(billing.usdToPhpRate) ||
            !Number.isInteger(billing.rounds) ||
            billing.rounds < 1 ||
            typeof billing.model !== "string" ||
            billing.model.length > 100
          ) {
            return res.status(400).json({
              ok: false,
              error: "Invalid assistant billing metadata."
            });
          }

          cleanMessage.billing = {
            model: billing.model,
            rounds: billing.rounds,
            costUsd: billing.costUsd,
            costPhp: billing.costPhp,
            remainingCreditsPhp: billing.remainingCreditsPhp,
            usdToPhpRate: billing.usdToPhpRate
          };

          if (billing.roundBreakdown !== undefined) {
            if (
              !Array.isArray(billing.roundBreakdown) ||
              billing.roundBreakdown.length > 10
            ) {
              return res.status(400).json({
                ok: false,
                error: "Invalid round billing metadata."
              });
            }

            cleanMessage.billing.roundBreakdown =
              billing.roundBreakdown.map((round, index) => {
                const numericFields = [
                  "costUsd",
                  "costPhp"
                ];

                if (
                  !round ||
                  typeof round !== "object" ||
                  !Number.isInteger(round.round) ||
                  round.round !== index + 1 ||
                  typeof round.model !== "string" ||
                  round.model.length > 100 ||
                  !Number.isInteger(round.inputTokens) ||
                  !Number.isInteger(round.cachedInputTokens) ||
                  !Number.isInteger(round.uncachedInputTokens) ||
                  !Number.isInteger(round.outputTokens) ||
                  numericFields.some(key => !validNumber(round[key]))
                ) {
                  throw new Error("Invalid round billing metadata.");
                }

                return {
                  round: round.round,
                  model: round.model,
                  inputTokens: round.inputTokens,
                  cachedInputTokens: round.cachedInputTokens,
                  uncachedInputTokens: round.uncachedInputTokens,
                  outputTokens: round.outputTokens,
                  costUsd: round.costUsd,
                  costPhp: round.costPhp
                };
              });
          }

          if (
            billing.usage &&
            typeof billing.usage === "object" &&
            !Array.isArray(billing.usage)
          ) {
            const usageKeys = [
              "input_tokens",
              "cached_input_tokens",
              "uncached_input_tokens",
              "output_tokens",
              "total_tokens"
            ];

            const cleanUsage = {};
            for (const key of usageKeys) {
              if (!Number.isInteger(billing.usage[key]) || billing.usage[key] < 0) {
                return res.status(400).json({
                  ok: false,
                  error: "Invalid billing usage metadata."
                });
              }
              cleanUsage[key] = billing.usage[key];
            }

            cleanMessage.billing.usage = cleanUsage;
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
  async (req, res) => {

    let creditsLockAcquired = false;
    const billingRequestId = randomUUID();

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

      // Check and lock this user's credits only after
      // validating the request, but before any OpenAI call.
      await reserveUserCredits(
        req.user.uid,
        billingRequestId
      );
      creditsLockAcquired = true;

      const result = await runDaneel({
        user: req.user,
        message: message.trim(),
        history: cleanHistory
      });

      // Calculate the total across every Responses API round,
      // then atomically deduct it from this user's Firestore balance.
      const billing = calculateInteractionBilling(
        result.roundUsage
      );

      const updatedCredits = await chargeUserCredits(
        req.user.uid,
        billingRequestId,
        billing.costPhp
      );

      creditsLockAcquired = false;

      billing.remainingCreditsPhp =
        updatedCredits.remainingCreditsPhp;

      billing.totalSpentPhp =
        updatedCredits.totalSpentPhp;

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

        usage: billing.usage,

        billing,

        toolCalls: result.toolCalls
      });

    } catch (error) {

      console.error(
        "Chat request failed:",
        error.message
      );

      if (creditsLockAcquired) {
        try {
          await releaseUserCreditsLock(
            req.user.uid,
            billingRequestId
          );
        } catch (releaseError) {
          console.error(
            "Unable to release billing lock:",
            releaseError.message
          );
        }
      }

      const status =
        Number.isInteger(error.status) ? error.status : 500;

      return res.status(status).json({
        ok: false,
        error: status === 500
          ? "An error occurred while processing your request."
          : error.message
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
