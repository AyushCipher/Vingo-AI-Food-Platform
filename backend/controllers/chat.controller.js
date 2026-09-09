import ChatMessage from '../models/chat.model.js';
import { findRuleBasedResponse, generateFallbackResponse } from '../config/knowledgeBase.js';
import { toolDeclarations, runTool } from '../services/chatTools.js';

// Read lazily (not at module load) — this file is imported before index.js's
// dotenv.config() runs, so a top-level read here would always capture
// `undefined` in local dev, silently disabling the Gemini fallback.
//
// Pinned to the "-latest" alias rather than a specific version on purpose:
// this file previously hardcoded gemini-1.5-flash, which Google has since
// retired (confirmed empirically — it now 404s), silently breaking the AI
// fallback in production. The alias tracks whatever flash-tier model is
// current, so a future model retirement degrades gracefully instead of
// breaking outright.
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

const SYSTEM_INSTRUCTION = `You are Vingo's in-app assistant for a food delivery and social platform.
You help with: finding food and comparing prices across restaurants in a city, checking the signed-in user's own order status and order history, and general delivery/payment/account support.

Use the provided tools whenever the user asks something that needs real, current data — prices, menus, restaurants, or their own orders. Never invent prices, restaurant names, or order details yourself.
If a tool reports an error (for example, that the user needs to sign in), relay that plainly instead of guessing.
Be concise and friendly. Prefer a short table or bullet list when comparing multiple items or shops.`;

/**
 * Get chat history for a session
 * GET /api/chat/history/:sessionId
 */
export const getChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const chatSession = await ChatMessage.findOne({ sessionId });

    if (!chatSession) {
      return res.status(404).json({
        success: false,
        message: 'Chat session not found',
      });
    }

    // Sessions created by a logged-in user can only be read by that same user.
    // Anonymous sessions (userId null) stay accessible by sessionId, matching
    // the pre-login chat flow this endpoint supports.
    if (chatSession.userId && chatSession.userId !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized for this chat session',
      });
    }

    res.status(200).json({
      success: true,
      sessionId,
      messages: chatSession.messages,
      lastInteraction: chatSession.lastInteraction,
    });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};

/**
 * Send a message and get bot response
 * POST /api/chat/message
 */
export const sendMessage = async (req, res) => {
  try {
    const { sessionId, userMessage, userRole, currentPage } = req.body;

    if (!sessionId || !userMessage) {
      return res.status(400).json({
        success: false,
        message: 'sessionId and userMessage are required',
      });
    }

    // Find or create chat session
    let chatSession = await ChatMessage.findOne({ sessionId });

    // Never trust a client-supplied userId — use the identity from the verified
    // auth cookie (optionalAuth) if present, otherwise the session is anonymous.
    const verifiedUserId = req.userId || null;

    if (chatSession && chatSession.userId && chatSession.userId !== verifiedUserId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized for this chat session',
      });
    }

    if (!chatSession) {
      chatSession = new ChatMessage({
        sessionId,
        userId: verifiedUserId,
        metadata: {
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
          context: {
            userRole,
            currentPage,
          },
        },
        messages: [],
      });
    }

    // Add user message
    chatSession.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    });

    // Update context
    chatSession.metadata.context.userRole = userRole || chatSession.metadata.context.userRole;
    chatSession.metadata.context.currentPage =
      currentPage || chatSession.metadata.context.currentPage;
    chatSession.lastInteraction = new Date();

    // Step 1: Try to find a rule-based response
    let ruleResponse = findRuleBasedResponse(userMessage);

    let botMessage = ruleResponse?.response;
    let responseSource = ruleResponse?.source || 'rule-based';

    console.log(`[CHAT] Rule match: ${ruleResponse ? ruleResponse.category : 'none'}`);

    // Step 2: If no rule match, use the DB-grounded agent for an intelligent response
    if (!ruleResponse) {
      console.log('[CHAT] No rule match, calling agent...');
      const aiResponse = await getAgentResponse(userMessage, chatSession.messages, {
        userId: verifiedUserId,
      });

      if (aiResponse) {
        botMessage = aiResponse;
        responseSource = 'ai';
        console.log('[CHAT] AI response received successfully');
      } else {
        console.log('[CHAT] AI response failed, using fallback');
      }
    }

    // Step 3: If both fail, use fallback
    if (!botMessage) {
      console.log('[CHAT] Both rule and AI failed, using fallback');
      const fallback = generateFallbackResponse();
      botMessage = fallback.response;
      responseSource = fallback.source;
    }

    // Add bot message
    chatSession.messages.push({
      role: 'bot',
      content: botMessage,
      timestamp: new Date(),
    });

    // Save to database
    await chatSession.save();

    res.status(200).json({
      success: true,
      message: botMessage,
      source: responseSource,
      sessionId,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};

/**
 * Tool friendly status message helper for UI streaming updates
 */
const getToolStatusLabel = (name, args) => {
  switch (name) {
    case "compareItemPrices":
      return `🏷️ Comparing prices for "${args?.itemName || "dish"}" in ${args?.city || "your city"}...`;
    case "searchMenuItems":
      return `🔍 Searching menu items matching "${args?.query || "options"}"...`;
    case "getShopsInCity":
      return `🏬 Discovering restaurants in ${args?.city || "your city"}...`;
    case "getOrderStatus":
      return `📦 Checking live order status...`;
    case "getOrderHistory":
      return `📜 Retrieving your recent order history...`;
    default:
      return `⚡ Querying live restaurant database...`;
  }
};

/**
 * Send message with real-time SSE token streaming
 * POST /api/chat/stream
 */
export const sendMessageStream = async (req, res) => {
  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendSSE = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    const { sessionId, userMessage, userRole, currentPage } = req.body;

    if (!sessionId || !userMessage) {
      sendSSE({ type: 'error', message: 'sessionId and userMessage are required' });
      return res.end();
    }

    let chatSession = await ChatMessage.findOne({ sessionId });
    const verifiedUserId = req.userId || null;

    if (chatSession && chatSession.userId && chatSession.userId !== verifiedUserId) {
      sendSSE({ type: 'error', message: 'Not authorized for this chat session' });
      return res.end();
    }

    if (!chatSession) {
      chatSession = new ChatMessage({
        sessionId,
        userId: verifiedUserId,
        metadata: {
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
          context: {
            userRole,
            currentPage,
          },
        },
        messages: [],
      });
    }

    // Add user message
    chatSession.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    });

    chatSession.metadata.context.userRole = userRole || chatSession.metadata.context.userRole;
    chatSession.metadata.context.currentPage = currentPage || chatSession.metadata.context.currentPage;
    chatSession.lastInteraction = new Date();

    // Step 1: Rule-based FAQ match
    const ruleResponse = findRuleBasedResponse(userMessage);

    if (ruleResponse) {
      const responseText = ruleResponse.response;
      sendSSE({ type: 'status', message: '⚡ Knowledge base match' });

      // Stream tokens in words with natural pacing
      const words = responseText.split(' ');
      for (const word of words) {
        sendSSE({ type: 'token', token: word + ' ' });
        await new Promise((r) => setTimeout(r, 15));
      }

      chatSession.messages.push({
        role: 'bot',
        content: responseText,
        timestamp: new Date(),
      });
      await chatSession.save();

      sendSSE({
        type: 'done',
        fullMessage: responseText,
        source: ruleResponse.source || 'rule-based',
        sessionId,
      });
      return res.end();
    }

    // Step 2: Agent execution with tool streaming
    sendSSE({ type: 'status', message: '🤖 Thinking and consulting live data...' });

    const agentResult = await getAgentResponseStreaming(
      userMessage,
      chatSession.messages,
      { userId: verifiedUserId },
      sendSSE
    );

    let finalBotMessage = agentResult?.text;
    let source = 'ai';

    if (!finalBotMessage) {
      const fallback = generateFallbackResponse();
      finalBotMessage = fallback.response;
      source = fallback.source;
      sendSSE({ type: 'token', token: finalBotMessage });
    }

    // Save final bot response
    chatSession.messages.push({
      role: 'bot',
      content: finalBotMessage,
      timestamp: new Date(),
    });
    await chatSession.save();

    sendSSE({
      type: 'done',
      fullMessage: finalBotMessage,
      source,
      sessionId,
    });
    return res.end();
  } catch (error) {
    console.error('Error in sendMessageStream:', error);
    sendSSE({
      type: 'error',
      message: 'Something went wrong while processing your request.',
    });
    return res.end();
  }
};

/**
 * Streaming Agent loop that emits status and token events as they occur
 */
async function getAgentResponseStreaming(userMessage, conversationHistory, context, sendSSE) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return null;
  }

  const priorMessages = conversationHistory.slice(0, -1).slice(-10);
  const contents = priorMessages.map((msg) => ({
    role: msg.role === 'bot' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const callGemini = async () => {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        tools: toolDeclarations,
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
      }),
    });
    const data = await response.json();
    if (!response.ok) return null;
    return data;
  };

  try {
    const MAX_TOOL_ROUNDS = 4;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callGemini();
      if (!data) return null;

      const parts = data.candidates?.[0]?.content?.parts;
      if (!parts || !parts.length) return null;

      const functionCallParts = parts.filter((p) => p.functionCall);
      if (functionCallParts.length === 0) {
        const textPart = parts.find((p) => p.text);
        const fullText = textPart?.text || '';

        // Stream final generated text in chunks
        const chunks = fullText.split(' ');
        for (const chunk of chunks) {
          sendSSE({ type: 'token', token: chunk + ' ' });
          await new Promise((r) => setTimeout(r, 12));
        }

        return { text: fullText };
      }

      contents.push({ role: 'model', parts });

      const responseParts = [];
      for (const part of functionCallParts) {
        const { name, args } = part.functionCall;
        const statusLabel = getToolStatusLabel(name, args);
        sendSSE({ type: 'tool_start', tool: name, message: statusLabel });

        const result = await runTool(name, args, context);
        sendSSE({ type: 'tool_end', tool: name });

        responseParts.push({ functionResponse: { name, response: result } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    return null;
  } catch (error) {
    console.error('Error in agent streaming:', error.message);
    return null;
  }
}

/**
 * Clear chat history (for user privacy)
 * DELETE /api/chat/history/:sessionId
 */
export const clearChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const chatSession = await ChatMessage.findOne({ sessionId });
    if (chatSession && chatSession.userId && chatSession.userId !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized for this chat session',
      });
    }

    await ChatMessage.deleteOne({ sessionId });

    res.status(200).json({
      success: true,
      message: 'Chat history cleared',
    });
  } catch (error) {
    console.error('Error clearing chat history:', error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};

/**
 * Get user's chat sessions (authenticated users)
 * GET /api/chat/sessions
 */
export const getUserChatSessions = async (req, res) => {
  try {
    // req.userId is guaranteed by the isAuth middleware on this route
    const userId = req.userId;

    const sessions = await ChatMessage.find({ userId })
      .select('sessionId messages lastInteraction')
      .sort({ lastInteraction: -1 })
      .limit(10); // Last 10 sessions

    res.status(200).json({
      success: true,
      sessions,
    });
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};
