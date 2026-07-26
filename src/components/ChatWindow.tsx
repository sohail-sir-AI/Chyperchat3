import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  arrayUnion
} from 'firebase/firestore';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Send,
  Key,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  ArrowLeft,
  Check,
  CheckCheck,
  CornerUpLeft,
  Trash2,
  X,
  Image as ImageIcon,
  Maximize2,
  Download,
  Loader2,
  FileText
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { encryptMessage, decryptMessage, EncryptedPayload } from '../lib/crypto';
import { processImageFile } from '../lib/imageUtils';
import { formatMessageTime, formatRelativeTime } from '../lib/dateUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: any;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock?: () => void;
  onBack?: () => void;
}

export default function ChatWindow({
  chat,
  currentUser,
  usersMap,
  onEmergencyLock,
  onBack
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [decryptionKey, setDecryptionKey] = useState('');
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Subscribe to messages in real-time
  useEffect(() => {
    const q = query(
      collection(db, 'chats', chat.id, 'messages'),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `chats/${chat.id}/messages`);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  // Mark unread messages as read
  useEffect(() => {
    if (!currentUser || messages.length === 0) return;

    const unreadMsgs = messages.filter(
      (m) => m.senderId !== currentUser.uid && (!m.readBy || !m.readBy.includes(currentUser.uid))
    );

    if (unreadMsgs.length === 0) return;

    const batch = writeBatch(db);
    unreadMsgs.forEach((msg) => {
      const msgRef = doc(db, 'chats', chat.id, 'messages', msg.id);
      batch.update(msgRef, {
        readBy: arrayUnion(currentUser.uid)
      });
    });

    batch.commit().catch((err) => {
      console.error('Failed to mark messages as read:', err);
    });
  }, [messages, chat.id, currentUser]);

  // Handle setting/confirming encryption key
  const handleConfirmKey = () => {
    if (!keyInput.trim()) {
      setKeyError('Key cannot be empty');
      return;
    }
    setDecryptionKey(keyInput.trim());
    setShowKeyPrompt(false);
    setKeyError('');
  };

  // Send text message
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !currentUser) return;

    if (isEncrypted && !decryptionKey) {
      setShowKeyPrompt(true);
      return;
    }

    setIsSending(true);
    setErrorMsg(null);

    try {
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      let payload: any = {
        id: messageId,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        senderPhoto: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        text: messageText,
        type: 'text',
        isEncrypted: false,
        readBy: [currentUser.uid],
        replyToId: replyingTo?.id || null,
        replyToSenderName: replyingTo?.senderName || null,
        replyToText: replyingTo
          ? replyingTo.type === 'image'
            ? '📸 Image'
            : replyingTo.isEncrypted
            ? '🔒 Encrypted Message'
            : replyingTo.text
          : null
      };

      if (isEncrypted && decryptionKey) {
        const encrypted = await encryptMessage(messageText, decryptionKey);
        payload.isEncrypted = true;
        payload.ciphertext = encrypted.ciphertext;
        payload.iv = encrypted.iv;
        payload.salt = encrypted.salt;
        payload.previewText = '🔒 Encrypted Message';
      }

      await setDoc(doc(db, 'chats', chat.id, 'messages', messageId), payload);

      // Update chat last message
      await updateDoc(doc(db, 'chats', chat.id), {
        lastMessage: {
          text: payload.isEncrypted ? '🔒 Encrypted Message' : messageText.substring(0, 50),
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });

      setMessageText('');
      setReplyingTo(null);
    } catch (error) {
      console.error('Send error:', error);
      setErrorMsg('Failed to send message. Please try again.');
    } finally {
      setIsSending(false);
    }
  };

  // Upload image
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;

    setIsSending(true);
    setErrorMsg(null);

    try {
      const imageDataUrl = await processImageFile(file);
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      let payload: any = {
        id: messageId,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        senderPhoto: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        text: '📸 Image',
        type: 'image',
        fileUrl: imageDataUrl,
        isEncrypted: false,
        readBy: [currentUser.uid]
      };

      if (isEncrypted && decryptionKey) {
        const encrypted = await encryptMessage(imageDataUrl, decryptionKey);
        payload.isEncrypted = true;
        payload.ciphertext = encrypted.ciphertext;
        payload.iv = encrypted.iv;
        payload.salt = encrypted.salt;
        payload.fileUrl = null;
      }

      await setDoc(doc(db, 'chats', chat.id, 'messages', messageId), payload);

      await updateDoc(doc(db, 'chats', chat.id), {
        lastMessage: {
          text: payload.isEncrypted ? '🔒 Encrypted Photo' : '📸 Image',
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Image error:', error);
      setErrorMsg('Failed to send photo. Please try again.');
    } finally {
      setIsSending(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Delete message from room
  const handleDeleteMessage = async (messageId: string) => {
    try {
      const msgRef = doc(db, 'chats', chat.id, 'messages', messageId);
      await deleteDoc(msgRef);
    } catch (error) {
      console.error('Failed to delete message:', error);
      setErrorMsg('Failed to delete message. Please try again.');
    }
  };

  // Locate current chat recipient (for direct chats)
  const getRecipientInfo = () => {
    if (chat.type !== 'direct') return null;
    const recipientId = chat.participantIds.find((id) => id !== currentUser?.uid);
    if (!recipientId) return null;
    return usersMap[recipientId] || null;
  };

  const recipient = getRecipientInfo();

  // Determine chat title
  const chatTitle =
    chat.type === 'direct'
      ? recipient?.displayName || 'Direct Chat'
      : chat.name || 'Group Chat';

  return (
    <div className="flex flex-col h-full bg-slate-950 border-l border-slate-900 overflow-hidden">
      {/* Header */}
      <div className="p-3.5 sm:p-4 border-b border-slate-900 flex items-center justify-between bg-slate-900/50 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          {recipient ? (
            <PresenceStatus user={recipient} showName={false} size="md" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 font-semibold shrink-0">
              {chatTitle.substring(0, 2).toUpperCase()}
            </div>
          )}

          <div className="min-w-0">
            <h2 className="font-semibold text-slate-100 truncate text-sm sm:text-base">{chatTitle}</h2>
            <p className="text-xs text-slate-400 truncate">
              {chat.type === 'direct' ? (
                recipient ? (
                  recipient.status === 'online' ? (
                    <span className="text-emerald-400 font-medium">Online</span>
                  ) : (
                    <span className="text-slate-400">
                      Last seen: {formatRelativeTime(recipient.lastSeen)}
                    </span>
                  )
                ) : (
                  'Direct Encrypted Chat'
                )
              ) : (
                `${chat.participantIds.length} members`
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Key status indicator */}
          <button
            onClick={() => setShowKeyPrompt(true)}
            className={`p-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
              decryptionKey
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                : 'bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20'
            }`}
            title={decryptionKey ? 'Encryption key configured' : 'Click to set encryption key'}
          >
            <Key className="w-4 h-4" />
            <span className="hidden sm:inline">{decryptionKey ? 'Key Active' : 'Set Key'}</span>
          </button>

          {onEmergencyLock && (
            <button
              onClick={onEmergencyLock}
              className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-500 transition-colors cursor-pointer"
              title="Emergency Lock"
            >
              <Lock className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Error alert banner */}
      {errorMsg && (
        <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-400 text-xs flex items-center justify-between shrink-0">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="hover:text-rose-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4 min-h-0">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center p-6">
            <div className="text-slate-600 max-w-xs">
              <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-slate-600/50" />
              <p className="text-sm font-medium text-slate-400">End-to-End Encrypted Room</p>
              <p className="text-xs text-slate-600 mt-1">
                Messages sent here are encrypted right on your device. Set a shared key to unlock full message contents.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUser?.uid;
            const readerNames = (msg.readBy || [])
              .filter((id) => id !== msg.senderId)
              .map((id) => usersMap[id]?.displayName || 'User')
              .join(', ');
            const isReadByOthers = (msg.readBy || []).some((id) => id !== msg.senderId);

            return (
              <div
                key={msg.id}
                className={`flex flex-col group/msg ${isMe ? 'items-end' : 'items-start'}`}
              >
                <div className={`flex items-end gap-2 max-w-[85%] sm:max-w-[75%] ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                  {!isMe && (
                    <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center text-xs font-semibold text-slate-300 shrink-0">
                      {msg.senderName?.substring(0, 1).toUpperCase() || '?'}
                    </div>
                  )}

                  <div
                    className={`rounded-2xl px-3.5 py-2.5 shadow-sm text-sm relative ${
                      isMe
                        ? 'bg-amber-600 text-slate-950 rounded-br-xs'
                        : 'bg-slate-900 border border-slate-800/80 text-slate-100 rounded-bl-xs'
                    }`}
                  >
                    {/* Reply Context Header */}
                    {msg.replyToText && (
                      <div
                        className={`mb-2 p-2 rounded text-xs border-l-2 ${
                          isMe
                            ? 'bg-amber-700/30 border-amber-950/40 text-amber-950'
                            : 'bg-slate-950/50 border-slate-700 text-slate-300'
                        }`}
                      >
                        <p className="font-semibold opacity-80">{msg.replyToSenderName || 'User'}</p>
                        <p className="truncate opacity-70">{msg.replyToText}</p>
                      </div>
                    )}

                    {/* Sender label for groups */}
                    {!isMe && chat.type === 'group' && (
                      <p className="text-[11px] font-semibold text-amber-400/90 mb-1">
                        {msg.senderName}
                      </p>
                    )}

                    {/* Message Body Content */}
                    <DecryptedContent
                      msg={msg}
                      decryptionKey={decryptionKey}
                      onPreviewImage={(url) => setPreviewImage(url)}
                      isMe={isMe}
                    />

                    {/* Footer Info: Time & Read Receipts */}
                    <div className={`flex items-center gap-1 justify-end mt-1 ${isMe ? 'text-slate-950/70' : 'text-slate-500'}`}>
                      <span className="text-[10px]">
                        {formatMessageTime(msg.timestamp)}
                      </span>
                      {isMe && (
                        <span className="flex items-center ml-0.5 cursor-help" title={isReadByOthers ? `Read by: ${readerNames}` : 'Sent'}>
                          {isReadByOthers ? (
                            <CheckCheck className="w-3.5 h-3.5 text-slate-950 font-bold" />
                          ) : (
                            <Check className="w-3.5 h-3.5 text-slate-950/70" />
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Action Buttons on Hover */}
                  <div className={`flex items-center gap-1 self-center opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 ${isMe ? 'order-first' : 'order-last'}`}>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(msg)}
                      className="p-1.5 rounded-full text-slate-500 hover:text-slate-300 hover:bg-slate-800 cursor-pointer transition-colors"
                      title="Reply"
                    >
                      <CornerUpLeft className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteMessage(msg.id)}
                      className="p-1.5 rounded-full text-slate-500 hover:text-rose-400 hover:bg-slate-800 cursor-pointer transition-colors"
                      title="Delete message"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Replying banner indicator */}
      {replyingTo && (
        <div className="px-4 py-2 bg-slate-900 border-t border-slate-800 flex items-center justify-between shrink-0 text-xs text-slate-300">
          <div className="flex items-center gap-2 truncate">
            <CornerUpLeft className="w-4 h-4 text-amber-500 shrink-0" />
            <span className="truncate">
              Replying to <strong className="text-amber-400">{replyingTo.senderName}</strong>: {replyingTo.previewText || 'Message'}
            </span>
          </div>
          <button onClick={() => setReplyingTo(null)} className="text-slate-400 hover:text-slate-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Encryption Key Notification Bar */}
      {isEncrypted && !decryptionKey && (
        <div className="p-2.5 bg-amber-500/10 border-t border-amber-500/20 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Key className="w-4 h-4 text-amber-500 shrink-0" />
            <span>Key missing. Messages will be encrypted using default channel lock.</span>
          </div>
          <button
            onClick={() => setShowKeyPrompt(true)}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-xs rounded transition-colors cursor-pointer shrink-0"
          >
            Set Custom Key
          </button>
        </div>
      )}

      {/* Key Input Modal */}
      {showKeyPrompt && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500">
                <Key className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-slate-100">Configure Shared Encryption Key</h3>
                <p className="text-xs text-slate-400">Set a passphrase to encrypt and decrypt messages locally.</p>
              </div>
            </div>

            <div className="space-y-3 mb-5">
              <input
                type="password"
                placeholder="Enter shared passphrase"
                value={keyInput}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  setKeyError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleConfirmKey()}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 text-sm"
              />
              {keyError && <p className="text-xs text-rose-400">{keyError}</p>}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowKeyPrompt(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-sm cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmKey}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-sm cursor-pointer transition-colors"
              >
                Apply Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full Screen Image Modal Preview */}
      {previewImage && (
        <div className="fixed inset-0 bg-slate-950/90 z-50 flex items-center justify-center p-4">
          <button
            onClick={() => setPreviewImage(null)}
            className="absolute top-4 right-4 p-2 bg-slate-800 rounded-full text-slate-300 hover:text-white cursor-pointer"
          >
            <X className="w-6 h-6" />
          </button>
          <img src={previewImage} alt="Full view" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}

      {/* Bottom Message Input Form */}
      <form onSubmit={handleSendMessage} className="p-3 sm:p-4 border-t border-slate-900 bg-slate-900/50 shrink-0">
        <div className="flex items-center gap-2 mb-2.5">
          <button
            type="button"
            onClick={() => setIsEncrypted(!isEncrypted)}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
              isEncrypted
                ? 'bg-amber-600 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {isEncrypted ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            {isEncrypted ? 'End-to-End Encrypted' : 'Plain Text'}
          </button>

          <input
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            ref={fileInputRef}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending}
            className="px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Photo
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder={isEncrypted && !decryptionKey ? 'Set encryption key above or type...' : 'Type encrypted message...'}
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            disabled={isSending}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 text-sm disabled:opacity-50"
          />

          <button
            type="submit"
            disabled={isSending || !messageText.trim()}
            className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold rounded-xl disabled:opacity-50 flex items-center justify-center cursor-pointer transition-colors shrink-0"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}

// Subcomponent to decrypt and render message payload safely
function DecryptedContent({
  msg,
  decryptionKey,
  onPreviewImage,
  isMe
}: {
  msg: ChatMessage;
  decryptionKey: string;
  onPreviewImage: (url: string) => void;
  isMe: boolean;
}) {
  const [decryptedText, setDecryptedText] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!msg.isEncrypted) {
      setDecryptedText(msg.text || null);
      return;
    }

    if (!decryptionKey || !msg.ciphertext) {
      setDecryptedText(null);
      return;
    }

    let isMounted = true;
    setIsDecrypting(true);
    setError(false);

    decryptMessage(
      {
        ciphertext: msg.ciphertext,
        iv: msg.iv || '',
        salt: msg.salt || ''
      },
      decryptionKey
    )
      .then((res) => {
        if (isMounted) {
          setDecryptedText(res);
          setIsDecrypting(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setError(true);
          setIsDecrypting(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [msg, decryptionKey]);

  if (!msg.isEncrypted) {
    if (msg.type === 'image' && msg.fileUrl) {
      return (
        <div className="mt-1">
          <img
            src={msg.fileUrl}
            alt="Shared photo"
            onClick={() => onPreviewImage(msg.fileUrl!)}
            className="max-w-xs max-h-60 rounded-lg object-cover cursor-pointer hover:opacity-95 transition-opacity"
          />
        </div>
      );
    }
    return <p className="break-words text-sm leading-relaxed">{msg.text}</p>;
  }

  // Encrypted message rendering logic
  if (!decryptionKey) {
    return (
      <div className="flex items-center gap-1.5 text-xs italic opacity-80 py-0.5">
        <Lock className="w-3.5 h-3.5" />
        <span>[Encrypted Message - Enter key to read]</span>
      </div>
    );
  }

  if (isDecrypting) {
    return (
      <div className="flex items-center gap-1.5 text-xs opacity-80 py-0.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Decrypting...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-rose-400 font-medium py-0.5">
        <ShieldAlert className="w-3.5 h-3.5" />
        <span>[Decryption Failed - Key Mismatch]</span>
      </div>
    );
  }

  if (msg.type === 'image' && decryptedText?.startsWith('data:image/')) {
    return (
      <div className="mt-1">
        <img
          src={decryptedText}
          alt="Decrypted photo"
          onClick={() => onPreviewImage(decryptedText)}
          className="max-w-xs max-h-60 rounded-lg object-cover cursor-pointer hover:opacity-95 transition-opacity"
        />
      </div>
    );
  }

  return <p className="break-words text-sm leading-relaxed">{decryptedText || msg.previewText}</p>;
          }import { processImageFile } from '../lib/imageUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: any;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock?: () => void;
  onBack?: () => void;
}

export default function ChatWindow({
  chat,
  currentUser,
  usersMap,
  onEmergencyLock,
  onBack
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [decryptionKey, setDecryptionKey] = useState('');
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Subscribe to messages
  useEffect(() => {
    const q = query(
      collection(db, 'chats', chat.id, 'messages'),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `chats/${chat.id}/messages`);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !currentUser) return;

    setIsSending(true);
    try {
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;
      
      let payload: any = {
        id: messageId,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        senderPhoto: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        text: messageText,
        isEncrypted: false,
        ciphertext: '',
        iv: '',
        salt: '',
        previewText: messageText.substring(0, 50)
      };

      if (isEncrypted && decryptionKey) {
        const encrypted = await encryptMessage(messageText, decryptionKey);
        payload.isEncrypted = true;
        payload.ciphertext = encrypted.ciphertext;
        payload.iv = encrypted.iv;
        payload.salt = encrypted.salt;
        payload.previewText = '🔒 Encrypted Message';
      }

      await setDoc(
        doc(db, 'chats', chat.id, 'messages', messageId),
        payload
      );

      // Update chat lastMessage
      await updateDoc(doc(db, 'chats', chat.id), {
        lastMessage: {
          text: payload.previewText,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });

      setMessageText('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chat.id}/messages`);
    } finally {
      setIsSending(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;

    setIsSending(true);
    try {
      const imageDataUrl = await processImageFile(file);
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      await setDoc(
        doc(db, 'chats', chat.id, 'messages', messageId),
        {
          id: messageId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'Anonymous',
          senderPhoto: currentUser.photoURL || '',
          timestamp: serverTimestamp(),
          text: '📸 Image',
          type: 'image',
          fileUrl: imageDataUrl,
          isEncrypted: false,
          previewText: '📸 Image'
        }
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chat.id}/messages`);
    } finally {
      setIsSending(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Determine chat title
  const chatTitle = chat.type === 'direct'
    ? (() => {
        const recipientId = chat.participantIds.find(id => id !== currentUser?.uid);
        return recipientId ? usersMap[recipientId]?.displayName || 'Direct Chat' : 'Direct Chat';
      })()
    : chat.name || 'Group Chat';

  return (
    <div className="flex flex-col h-full bg-slate-950 border-l border-slate-900">
      {/* Header */}
      <div className="p-4 border-b border-slate-900 flex items-center justify-between bg-slate-900/50">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden p-2 rounded hover:bg-slate-800 text-slate-400"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div>
            <h2 className="font-semibold text-slate-100">{chatTitle}</h2>
            <p className="text-xs text-slate-500">
              {chat.type === 'direct' 
                ? 'Direct Encrypted Chat'
                : `${chat.participantIds.length} members`
              }
            </p>
          </div>
        </div>
        {onEmergencyLock && (
          <button
            onClick={onEmergencyLock}
            className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-500"
            title="Emergency Lock"
          >
            <Lock className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center">
            <div className="text-slate-600">
              <ShieldCheck className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No messages yet</p>
              <p className="text-xs text-slate-700 mt-1">Start your encrypted conversation</p>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-2 ${msg.senderId === currentUser?.uid ? 'justify-end' : ''}`}
            >
              {msg.senderId !== currentUser?.uid && (
                <PresenceStatus user={usersMap[msg.senderId]} className="scale-75" />
              )}
              <div
                className={`max-w-xs px-4 py-2 rounded-lg ${
                  msg.senderId === currentUser?.uid
                    ? 'bg-amber-600 text-slate-950'
                    : 'bg-slate-800 text-slate-100'
                }`}
              >
                {msg.type === 'image' && msg.fileUrl ? (
                  <img src={msg.fileUrl} alt="shared" className="max-w-xs rounded" />
                ) : (
                  <p className="text-sm break-words">{msg.previewText}</p>
                )}
                <p className="text-xs mt-1 opacity-70">
                  {new Date(msg.timestamp?.toMillis?.()).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Encryption Key Setup */}
      {isEncrypted && !decryptionKey && (
        <div className="p-3 bg-amber-500/10 border-t border-amber-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-amber-400">Set encryption key to send messages</span>
          </div>
          <button
            onClick={() => setShowKeyPrompt(true)}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-xs rounded"
          >
            Set Key
          </button>
        </div>
      )}

      {/* Key Prompt Modal */}
      {showKeyPrompt && (
        <div className="fixed inset-0 bg-slate-950/80 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 w-96">
            <h3 className="font-bold mb-4 text-slate-100">Set Encryption Key</h3>
            <input
              type="password"
              placeholder="Enter shared encryption key"
              value={decryptionKey}
              onChange={(e) => setDecryptionKey(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-200 mb-4 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowKeyPrompt(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded font-semibold text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowKeyPrompt(false)}
                className="flex-1 bg-amber-600 hover:bg-amber-500 text-slate-950 py-2 rounded font-semibold text-sm"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message Input */}
      <form onSubmit={handleSendMessage} className="p-4 border-t border-slate-900 bg-slate-900/50">
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setIsEncrypted(!isEncrypted)}
            className={`px-3 py-1 rounded text-xs font-semibold flex items-center gap-1 ${
              isEncrypted
                ? 'bg-amber-600 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {isEncrypted ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            {isEncrypted ? 'Encrypted' : 'Plain'}
          </button>
          <input
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            ref={fileInputRef}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1 rounded text-xs font-semibold bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 flex items-center gap-1"
          >
            <ImageIcon className="w-3 h-3" />
            Image
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type a message..."
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            disabled={isEncrypted && !decryptionKey}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !messageText.trim()}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
