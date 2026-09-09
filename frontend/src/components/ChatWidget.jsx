import React, { useState, useEffect } from 'react';
import ChatInterface from './ChatInterface';

const ChatWidget = ({ userId, userRole }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);

  // Generate or retrieve session ID
  useEffect(() => {
    const existingSessionId = localStorage.getItem('chatSessionId');

    if (existingSessionId) {
      setSessionId(existingSessionId);
    } else {
      // Generate new session ID using a cryptographically random UUID
      const newSessionId = `session_${crypto.randomUUID()}`;
      localStorage.setItem('chatSessionId', newSessionId);
      setSessionId(newSessionId);
    }
  }, []);

  const toggleChat = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setUnreadCount(0); // Clear unread count when opening
    }
  };

  return (
    <>
      {/* Floating Chat Button */}
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={toggleChat}
          title="Chat with Vingo Support"
          aria-label={isOpen ? 'Close chat support' : 'Open chat support'}
          aria-expanded={isOpen}
          className="w-14 h-14 rounded-full bg-[#ff4d2d] hover:bg-[#e03a1b] text-white flex items-center justify-center shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all duration-200 cursor-pointer relative"
        >
          {isOpen ? (
            <span className="text-xl font-bold">✕</span>
          ) : (
            <span className="text-2xl">💬</span>
          )}
          {unreadCount > 0 && !isOpen && (
            <span className="absolute -top-1 -right-1 bg-emerald-500 text-white text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-white animate-pulse">
              {unreadCount}
            </span>
          )}
        </button>

        {/* Chat Window */}
        {isOpen && sessionId && (
          <div className="fixed bottom-24 right-4 sm:right-6 w-[calc(100vw-2rem)] sm:w-96 max-w-[420px] h-[520px] max-h-[80vh] z-50 transition-all duration-300">
            <ChatInterface
              sessionId={sessionId}
              userId={userId}
              userRole={userRole}
              onClose={() => setIsOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Overlay for mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/25 backdrop-blur-xs z-40 sm:hidden transition-opacity"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

export default ChatWidget;
