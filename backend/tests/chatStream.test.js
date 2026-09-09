import { describe, it, expect, vi, beforeEach } from "vitest";

const ChatMessageMock = vi.hoisted(() => {
  const Mock = function (data) {
    return {
      ...data,
      metadata: { context: {} },
      messages: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
  };
  Mock.findOne = vi.fn();
  return Mock;
});

vi.mock("../models/chat.model.js", () => ({
  default: ChatMessageMock,
}));

const { sendMessageStream } = await import("../controllers/chat.controller.js");

describe("Chat SSE Streaming Controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error SSE event if required fields are missing", async () => {
    const writtenData = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk) => writtenData.push(chunk)),
      end: vi.fn(),
      writableEnded: false,
    };

    const req = {
      body: { sessionId: "sess_1" }, // missing userMessage
      userId: "user_1",
      headers: {},
      ip: "127.0.0.1",
    };

    await sendMessageStream(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(writtenData.some((d) => d.includes("sessionId and userMessage are required"))).toBe(true);
    expect(res.end).toHaveBeenCalled();
  });

  it("streams knowledge base answer with tokens for matching FAQs", async () => {
    ChatMessageMock.findOne.mockResolvedValueOnce(null);

    const writtenData = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk) => writtenData.push(chunk)),
      end: vi.fn(),
      writableEnded: false,
    };

    const req = {
      body: {
        sessionId: "sess_faq",
        userMessage: "how to track my order",
        userRole: "customer",
      },
      userId: "user_1",
      headers: {},
      ip: "127.0.0.1",
    };

    await sendMessageStream(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(writtenData.some((d) => d.includes('"type":"token"'))).toBe(true);
    expect(writtenData.some((d) => d.includes('"type":"done"'))).toBe(true);
    expect(res.end).toHaveBeenCalled();
  });
});
