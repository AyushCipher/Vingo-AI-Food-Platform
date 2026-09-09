import React, { useState, useEffect, useRef } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const ChatInterface = ({ sessionId, userRole, onClose }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, statusText]);

  // Fetch chat history when component mounts
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/chat/history/${sessionId}`,
          {
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setMessages(data.messages || []);
        }
      } catch (err) {
        console.error('Error fetching chat history:', err);
      }
    };

    fetchHistory();
  }, [sessionId]);

  const handleSendMessage = async (e) => {
    e.preventDefault();

    if (!inputValue.trim() || isLoading) return;

    const userMessage = inputValue.trim();
    setInputValue('');
    setError('');

    // Append user message immediately
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: userMessage,
        timestamp: new Date(),
      },
    ]);

    setIsLoading(true);
    setStatusText('🤖 Thinking and searching...');

    try {
      const response = await fetch(`${API_URL}/api/chat/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          userMessage,
          userRole: userRole === 'user' ? 'customer' : (userRole || 'customer'),
          currentPage: window.location.pathname,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to establish stream connection');
      }

      // Add placeholder bot message for live token streaming
      let botMessageContent = '';
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          content: '',
          timestamp: new Date(),
          source: 'ai',
          isStreaming: true,
        },
      ]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));

            if (data.type === 'status' || data.type === 'tool_start') {
              setStatusText(data.message || '⚡ Consulting live data...');
            } else if (data.type === 'tool_end') {
              setStatusText('✍️ Formulating answer...');
            } else if (data.type === 'token') {
              botMessageContent += data.token;
              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === 'bot') {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    content: botMessageContent,
                    isStreaming: true,
                  };
                }
                return updated;
              });
            } else if (data.type === 'done') {
              setStatusText('');
              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === 'bot') {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    content: data.fullMessage || botMessageContent,
                    source: data.source || 'ai',
                    isStreaming: false,
                  };
                }
                return updated;
              });
            } else if (data.type === 'error') {
              setError(data.message || 'Error occurred');
            }
          } catch (jsonErr) {
            console.warn('Error parsing SSE chunk:', jsonErr);
          }
        }
      }
    } catch (err) {
      console.error('Error in chat stream:', err);
      setError('Network connection error. Please try again.');
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          content: 'Sorry, I encountered an error while processing. Please try again.',
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
      setStatusText('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl overflow-hidden shadow-2xl font-sans border border-gray-100">
      {/* Header */}
      <div className="flex justify-between items-center px-4 py-3.5 bg-[#ff4d2d] text-white shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></div>
          <div>
            <h3 className="font-semibold text-sm sm:text-base leading-tight">Vingo Assistant</h3>
            <span className="text-[11px] text-orange-100">Grounded AI • Instant Support</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full flex items-center justify-center text-white/80 hover:text-white hover:bg-white/20 transition-all cursor-pointer"
          aria-label="Close chat"
        >
          ✕
        </button>
      </div>

      {/* Real-time Tool & Status Banner */}
      {statusText && (
        <div className="px-3.5 py-1.5 bg-orange-50/90 border-b border-orange-100/80 text-[#ff4d2d] text-xs flex items-center gap-2 font-medium animate-pulse">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff4d2d]"></span>
          <span className="truncate">{statusText}</span>
        </div>
      )}

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/60 scroll-smooth">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center p-4 my-auto h-full space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-orange-100 flex items-center justify-center text-2xl shadow-inner">
              🍲
            </div>
            <div>
              <h4 className="font-semibold text-gray-800 text-sm sm:text-base">Welcome to Vingo AI!</h4>
              <p className="text-xs text-gray-500 mt-1 max-w-[220px]">
                Ask me to find dishes, compare restaurant prices, check your orders, or ask delivery FAQs.
              </p>
            </div>

            <div className="w-full space-y-2 pt-2">
              <button
                type="button"
                className="w-full text-left px-3 py-2 bg-white hover:bg-orange-50 hover:text-[#ff4d2d] hover:border-[#ff4d2d] text-xs font-medium text-gray-700 border border-gray-200 rounded-xl transition-all shadow-2xs cursor-pointer"
                onClick={() => setInputValue('Find something spicy and crispy under 250')}
              >
                🌶️ Spicy & crispy food under ₹250
              </button>
              <button
                type="button"
                className="w-full text-left px-3 py-2 bg-white hover:bg-orange-50 hover:text-[#ff4d2d] hover:border-[#ff4d2d] text-xs font-medium text-gray-700 border border-gray-200 rounded-xl transition-all shadow-2xs cursor-pointer"
                onClick={() => setInputValue('Compare butter chicken prices in Mumbai')}
              >
                🏷️ Compare dish prices across shops
              </button>
              <button
                type="button"
                className="w-full text-left px-3 py-2 bg-white hover:bg-orange-50 hover:text-[#ff4d2d] hover:border-[#ff4d2d] text-xs font-medium text-gray-700 border border-gray-200 rounded-xl transition-all shadow-2xs cursor-pointer"
                onClick={() => setInputValue('What is the status of my recent order?')}
              >
                📦 Check my order status
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg, index) => (
            <div
              key={index}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} transition-all`}
            >
              <div
                className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed shadow-xs whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-[#ff4d2d] text-white rounded-br-xs'
                    : 'bg-white text-gray-800 border border-gray-200/80 rounded-bl-xs'
                }`}
              >
                {msg.content}
                {msg.isStreaming && (
                  <span className="inline-block w-1.5 h-3.5 bg-[#ff4d2d] ml-1 animate-pulse align-middle" />
                )}
              </div>
              {msg.source === 'ai' && msg.role === 'bot' && !msg.isStreaming && (
                <span className="text-[10px] text-gray-400 mt-1 px-1 flex items-center gap-1 font-medium">
                  🤖 Grounded AI
                </span>
              )}
            </div>
          ))
        )}

        {error && (
          <div className="p-2.5 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl text-xs text-center font-medium">
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <form onSubmit={handleSendMessage} className="p-3 bg-white border-t border-gray-100 flex items-center gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Ask anything about food, orders..."
          disabled={isLoading}
          maxLength={300}
          className="flex-1 bg-gray-50 text-gray-800 placeholder-gray-400 text-xs sm:text-sm px-3.5 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#ff4d2d]/30 focus:border-[#ff4d2d] transition-all disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={isLoading || !inputValue.trim()}
          className="px-4 py-2 bg-[#ff4d2d] hover:bg-[#e03a1b] text-white text-xs sm:text-sm font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm cursor-pointer"
        >
          Send
        </button>
      </form>
    </div>
  );
};

export default ChatInterface;
