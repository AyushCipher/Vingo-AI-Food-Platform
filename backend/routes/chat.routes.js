import express from 'express';
import isAuth from '../middlewares/isAuth.js';
import optionalAuth from '../middlewares/optionalAuth.js';
import {
  getChatHistory,
  sendMessage,
  sendMessageStream,
  clearChatHistory,
  getUserChatSessions,
} from '../controllers/chat.controller.js';

const router = express.Router();

// Public routes (chat must stay usable by anonymous visitors), but req.userId
// is set from the auth cookie when present so ownership can be enforced below
router.post('/message', optionalAuth, sendMessage); // Send message and get bot response
router.post('/stream', optionalAuth, sendMessageStream); // Real-time SSE token stream
router.get('/history/:sessionId', optionalAuth, getChatHistory); // Get chat history
router.delete('/history/:sessionId', optionalAuth, clearChatHistory); // Clear chat history

// Requires login: this endpoint only makes sense for a specific user's sessions
router.get('/sessions', isAuth, getUserChatSessions); // Get user's previous sessions

export default router;
