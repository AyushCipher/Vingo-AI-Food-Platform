import express from "express"
import dotenv from "dotenv"
dotenv.config()

import connectDb from "./config/db.js"
import cookieParser from "cookie-parser"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import pinoHttp from "pino-http"
import authRouter from "./routes/auth.routes.js"
import userRouter from "./routes/user.routes.js"
import shopRouter from "./routes/shop.routes.js"
import itemRouter from "./routes/item.routes.js"
import orderRouter from "./routes/order.routes.js"
import reviewRouter from "./routes/review.routes.js"
import reelRouter from "./routes/reel.routes.js"
import chatRouter from "./routes/chat.routes.js"
import http from "http"
import { Server } from "socket.io"
import socketHandler from "./socket.js"
import validateEnv from "./config/validateEnv.js"
import logger from "./config/logger.js"
import errorHandler, { notFoundHandler } from "./middlewares/errorHandler.js"

import { createAdapter } from "@socket.io/redis-adapter"
import { createRedisPubSubClients } from "./config/redis.js"

validateEnv()

const port = process.env.PORT || 5000
const app = express()

// Trust proxy for secure cookies behind Render's reverse proxy
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const server = http.createServer(app)

// Allowed origins for CORS - includes both dev and production URLs
const allowedOrigins = [
  "http://localhost:5173",
  "https://vingo-8134.onrender.com"
].filter(Boolean);

const io = new Server(server,{
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true  
  }
})

const redisPubSub = createRedisPubSubClients();
if (redisPubSub) {
  io.adapter(createAdapter(redisPubSub.pubClient, redisPubSub.subClient));
  logger.info("✅ Socket.io Redis adapter configured for multi-instance scaling");
}

app.set("io", io);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(helmet())
app.use(pinoHttp({ logger }))

app.use(express.json())
app.use(cookieParser())

// General abuse guard on all API routes, with a stricter limit on the two
// endpoints most exposed to cost/abuse: auth (credential stuffing, OTP spam)
// and chat (each miss burns a Gemini API call).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
})
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again later" },
})
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many messages, please slow down" },
})

app.use("/api", apiLimiter)
app.use("/api/auth", authLimiter, authRouter)
app.use("/api/user", userRouter)
app.use("/api/shop", shopRouter)
app.use("/api/item", itemRouter)
app.use("/api/order", orderRouter)
app.use("/api/review", reviewRouter)
app.use("/api/reel", reelRouter)
app.use("/api/chat", chatLimiter, chatRouter)

app.use(notFoundHandler)
app.use(errorHandler)

socketHandler(io)

server.listen(port,()=>{
  logger.info(`Server started at port no. ${port}`)
  connectDb()
})

