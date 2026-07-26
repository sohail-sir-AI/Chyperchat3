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
  Loader2
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
  onEmergencyLock: () => void;
  onBack?: () => void;
}

export default function ChatWindow({ chat, currentUser, usersMap, onEmergencyLock, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  const [tempPassphrase, setTempPassphrase] = useState('');
  const [showTempPassphrase, setShowTempPassphrase] = useState(false);

  const [replyingTo, setReplyingTo] = useState<{ id: string; senderName: string; text: string } | null>(null);
  
  const [selectedImage, setSelectedImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTempPassphrase(passphrase);
  }, [passphrase, chat.id]);

  useEffect(() => {
    setReplyingTo(null);
    setSelectedImage(null);
  }, [chat.id]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (isTypingRef.current && currentUser) {
        const chatDocRef = doc(db, 'chats', chat.id);
        updateDoc(chatDocRef, {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Unmount typing cleanup failed:", err));
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      isTypingRef.current = false;
    };
  }, [chat.id, currentUser]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputText(val);

    if (!currentUser) return;

    if (val.trim()) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: true
        }).catch(err => console.error("Failed to start typing update:", err));
      }

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to stop typing update:", err));
      }, 3000);
    } else {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to clear typing update:", err));
      }
    }
  };

  const getTypingUsers = () => {
    if (!chat.isTyping) return [];
    return Object.entries(chat.isTyping)
      .filter(([uid, isTyping]) => {
        if (!isTyping || uid === currentUser?.uid) return false;
        const user = usersMap[uid];
        if (!user) return false;
        if (user.status !== 'online') return false;
        const lastSeenMs = user.lastSeen?.toMillis() || 0;
        return (nowMs - lastSeenMs) < 120000;
      })
      .map(([uid]) => usersMap[uid])
      .filter(Boolean);
  };

  const typingUsers = getTypingUsers();
  const isSomeoneTyping = typingUsers.length > 0;

  const triggerEmergencyLock = () => {
    setPassphrase('');
    setInputText('');
    onEmergencyLock();
  };

  useEffect(() => {
    const messagesPath = `chats/${chat.id}/messages`;
    const q = query(collection(db, messagesPath), orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
        setErrorMsg('');
      },
      (error) => {
        if ((error as any)?.code === 'unavailable') {
          console.warn('Messages listener operating in offline mode:', error);
          return;
        }
        handleFirestoreError(error, OperationType.LIST, messagesPath);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, decryptedMessages]);

  useEffect(() => {
    if (!currentUser) return;
    
    const unreadMsgs = messages.filter(
      (msg) => !msg.readBy || !msg.readBy.includes(currentUser.uid)
    );

    if (unreadMsgs.length === 0) return;

    const updateReadReceipts = async () => {
      try {
        const batch = writeBatch(db);
        unreadMsgs.forEach((msg) => {
          const currentReadBy = msg.readBy || [];
          const updatedReadBySet = new Set([...currentReadBy, currentUser.uid]);
          const everyoneHasRead = chat.participantIds.every((id) => updatedReadBySet.has(id));

          const msgRef = doc(db, 'chats', chat.id, 'messages', msg.id);
          batch.update(msgRef, {
            readBy: arrayUnion(currentUser.uid),
            ...(everyoneHasRead ? { isRead: true } : {})
          });
        });
        await batch.commit();
      } catch (error) {
        console.error('Failed to update read receipts:', error);
      }
    };

    updateReadReceipts();
  }, [messages, currentUser, chat.id, chat.participantIds]);

  useEffect(() => {
    if (!passphrase) {
      setDecryptedMessages({});
      return;
    }

    const decryptAll = async () => {
      setIsDecrypting(true);
      const decMap: Record<string, string> = {};
      
      for (const msg of messages) {
        if (!msg.isEncrypted) {
          decMap[msg.id] = msg.previewText;
          continue;
        }

        try {
          const payload: EncryptedPayload = {
            ciphertext: msg.ciphertext,
            iv: msg.iv,
            salt: msg.salt
          };
          const decrypted = await decryptMessage(payload, passphrase);
          decMap[msg.id] = decrypted;
        } catch (err) {
          decMap[msg.id] = '🔒 [Decryption Failed: Incorrect Passcode]';
        }
      }
      
      setDecryptedMessages(decMap);
      setIsDecrypting(false);
    };

    const timeout = setTimeout(decryptAll, 150);
    return () => clearTimeout(timeout);
  }, [messages, passphrase]);

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file (PNG, JPEG, WebP, GIF).');
      return;
    }

    try {
      setIsProcessingImage(true);
      setErrorMsg('');
      const compressedDataUrl = await processImageFile(file);
      setSelectedImage({
        dataUrl: compressedDataUrl,
        name: file.name
      });
    } catch (err: any) {
      console.error('Failed to process image:', err);
      setErrorMsg(err?.message || 'Failed to process selected image file.');
    } finally {
      setIsProcessingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputText.trim() && !selectedImage) || !currentUser) return;

    if (!passphrase) {
      setErrorMsg('An Encryption Passcode is required to send messages securely.');
      return;
    }

    try {
      setErrorMsg('');
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;
      
      const payloadToEncrypt = JSON.stringify({
        text: inputText.trim(),
        image: selectedImage ? selectedImage.dataUrl : null,
        replyTo: replyingTo
      });

      const encrypted = await encryptMessage(payloadToEncrypt, passphrase);

      let previewText = '🔒 Encrypted Message';
      if (selectedImage && inputText.trim()) {
        previewText = `🔒 Image: ${inputText.trim().substring(0, 30)}...`;
      } else if (selectedImage) {
        previewText = '🔒 Image Attachment';
      } else if (inputText.trim()) {
        previewText = `🔒 ${inputText.trim().substring(0, 30)}...`;
      }

      const msgData: Partial<ChatMessage> = {
        id: messageId,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        senderPhoto: currentUser.photoURL || '',
        timestamp: serverTimestamp() as any,
        isEncrypted: true,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        salt: encrypted.salt,
        previewText: previewText,
        readBy: [currentUser.uid],
        isRead: chat.participantIds.length === 1
      };

      const messagesPath = `chats/${chat.id}/messages`;
      await setDoc(doc(db, messagesPath, messageId), msgData);

      const chatDocRef = doc(db, 'chats', chat.id);
      await updateDoc(chatDocRef, {
        lastMessage: {
          text: previewText,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp(),
        [`isTyping.${currentUser.uid}`]: false
      });

      setInputText('');
      setReplyingTo(null);
      setSelectedImage(null);
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chat.id}/messages`);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      const msgRef = doc(db, 'chats', chat.id, 'messages', messageId);
      await deleteDoc(msgRef);
    } catch (error) {
      console.error('Failed to delete message:', error);
      setErrorMsg('Failed to delete message. Please try again.');
    }
  };

  const getRecipientInfo = () => {
    if (chat.type !== 'direct') return null;
    const recipientId = chat.participantIds.find((id) => id !== currentUser?.uid);
    if (!recipientId) return null;
    return usersMap[recipientId] || null;
  };

  const recipient = getRecipientInfo();

  return (
    <div className="flex flex-col h-full bg-slate-950 relative overflow-hidden">
      {/* Header */}
      <div className="bg-slate-900/90 backdrop-blur border-b border-slate-800 p-3.5 sm:p-4 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="md:hidden p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          {chat.type === 'direct' && recipient ? (
            <PresenceStatus user={recipient} showText={false} />
          ) : (
            <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-amber-500 font-bold shrink-0">
              {chat.name?.[0]?.toUpperCase() || 'G'}
            </div>
          )}

          <div className="flex flex-col min-w-0">
            <h2 className="font-semibold text-slate-100 text-sm sm:text-base truncate">
              {chat.type === 'direct' ? recipient?.displayName || 'Direct Chat' : chat.name}
            </h2>

            {chat.type === 'direct' && recipient ? (
              <span className="text-[11px] text-slate-400">
                {recipient.status === 'online' ? (
                  <span className="text-emerald-400 font-medium">Online</span>
                ) : (
                  <span className="text-slate-400">
                    Last seen: {formatRelativeTime(recipient.lastSeen)}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[11px] text-slate-400">
                {chat.participantIds.length} members
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={triggerEmergencyLock}
            className="p-2 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors cursor-pointer"
            title="Emergency Lock & Wipe Memory"
          >
            <Lock className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Passcode Bar */}
      <div className="bg-slate-900/60 border-b border-slate-800 px-3 py-2 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Key className={`w-4 h-4 shrink-0 ${passphrase ? 'text-amber-500' : 'text-slate-500'}`} />
          <div className="relative flex-1 max-w-xs">
            <input
              type={showPassphrase ? 'text' : 'password'}
              value={tempPassphrase}
              onChange={(e) => setTempPassphrase(e.target.value)}
              placeholder="Enter E2EE Shared Passcode"
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 pr-7"
            />
            <button
              type="button"
              onClick={() => setShowPassphrase(!showPassphrase)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              {showPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setPassphrase(tempPassphrase)}
            className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-xs rounded transition-colors cursor-pointer shrink-0"
          >
            Apply Key
          </button>
        </div>

        {passphrase ? (
          <span className="hidden sm:flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
            <ShieldCheck className="w-3 h-3" /> E2EE Active
          </span>
        ) : (
          <span className="hidden sm:flex items-center gap-1 text-[11px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
            <ShieldAlert className="w-3 h-3" /> Key Required
          </span>
        )}
      </div>

      {errorMsg && (
        <div className="bg-rose-500/10 border-b border-rose-500/20 px-4 py-2 text-xs text-rose-400 flex items-center justify-between shrink-0">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg('')} className="text-rose-400 hover:text-rose-200">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-600">
            <Shield className="w-12 h-12 mb-3 text-slate-700" />
            <p className="text-sm font-medium text-slate-400">End-to-End Encrypted Channel</p>
            <p className="text-xs text-slate-600 max-w-xs mt-1">
              Messages and attachments are encrypted client-side using AES-256 before transmission.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUser?.uid;
            const decryptedContent = decryptedMessages[msg.id];
            
            let msgText = '';
            let msgImage: string | null = null;
            let msgReplyTo: any = null;

            if (decryptedContent && !decryptedContent.startsWith('🔒')) {
              try {
                const parsed = JSON.parse(decryptedContent);
                msgText = parsed.text || '';
                msgImage = parsed.image || null;
                msgReplyTo = parsed.replyTo || null;
              } catch {
                msgText = decryptedContent;
              }
            }

            const readByList = msg.readBy || [];
            const isReadByOthers = readByList.some((uid) => uid !== currentUser?.uid);
            const readerNames = readByList
              .filter((uid) => uid !== currentUser?.uid)
              .map((uid) => usersMap[uid]?.displayName || 'Participant')
              .join(', ');

            return (
              <div
                key={msg.id}
                className={`flex flex-col group/msg ${isMe ? 'items-end' : 'items-start'}`}
              >
                <div className={`flex items-end gap-2 max-w-[85%] sm:max-w-[70%] ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                  {!isMe && (
                    <img
                      src={msg.senderPhoto || `https://api.dicebear.com/7.x/bottts/svg?seed=${msg.senderId}`}
                      alt={msg.senderName}
                      className="w-6 h-6 rounded-full border border-slate-800 object-cover shrink-0 mb-1"
                    />
                  )}

                  <div
                    className={`rounded-2xl p-3 shadow-md relative overflow-hidden transition-all ${
                      isMe
                        ? 'bg-amber-600 text-slate-950 rounded-br-xs'
                        : 'bg-slate-900 border border-slate-800 text-slate-100 rounded-bl-xs'
                    }`}
                  >
                    {!isMe && chat.type === 'group' && (
                      <span className="block text-[10px] font-bold text-amber-400 mb-1">
                        {msg.senderName}
                      </span>
                    )}

                    {msgReplyTo && (
                      <div className={`text-xs p-2 rounded mb-2 border-l-2 ${
                        isMe ? 'bg-amber-700/40 border-slate-950/60 text-slate-900' : 'bg-slate-950/50 border-amber-500 text-slate-300'
                      }`}>
                        <span className="font-semibold block text-[10px]">{msgReplyTo.senderName}</span>
                        <span className="truncate block opacity-80">{msgReplyTo.text}</span>
                      </div>
                    )}

                    {!passphrase ? (
                      <div className="flex items-center gap-1.5 text-xs italic opacity-80">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>Encrypted Message</span>
                      </div>
                    ) : decryptedContent?.startsWith('🔒') ? (
                      <div className="flex items-center gap-1.5 text-xs text-rose-400">
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                        <span>Decryption Failed</span>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {msgImage && (
                          <div className="relative group/img rounded-lg overflow-hidden max-w-xs bg-slate-950/50 border border-slate-800/50">
                            <img
                              src={msgImage}
                              alt="Attachment"
                              className="w-full h-auto max-h-60 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => setExpandedImageUrl(msgImage)}
                            />
                            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={() => setExpandedImageUrl(msgImage)}
                                className="p-1 bg-slate-950/80 text-slate-200 rounded hover:text-white"
                                title="Expand image"
                              >
                                <Maximize2 className="w-3.5 h-3.5" />
                              </button>
                              <a
                                href={msgImage}
                                download="cypher-encrypted-image.png"
                                className="p-1 bg-slate-950/80 text-slate-200 rounded hover:text-white"
                                title="Download image"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          </div>
                        )}
                        {msgText && <p className="text-xs sm:text-sm whitespace-pre-wrap break-words">{msgText}</p>}
                      </div>
                    )}

                    <div className={`flex items-center justify-end gap-1 text-[9px] mt-1 ${
                      isMe ? 'text-slate-900/70 font-mono' : 'text-slate-500'
                    }`}>
                      <span>{formatMessageTime(msg.timestamp)}</span>
                      {isMe && (
                        <span title={isReadByOthers ? `Read by: ${readerNames}` : 'Sent'}>
                          {isReadByOthers ? (
                            <CheckCheck className="w-3 h-3 text-slate-950 font-bold" />
                          ) : (
                            <Check className="w-3 h-3 text-slate-900/60" />
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions on hover */}
                  <div className={`flex items-center gap-1 self-center opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 ${isMe ? 'order-first' : 'order-last'}`}>
                    <button
                      type="button"
                      onClick={() => setReplyingTo({
                        id: msg.id,
                        senderName: msg.senderName,
                        text: msgText || msg.previewText
                      })}
                      className="p-1.5 rounded-full text-slate-500 hover:text-amber-400 hover:bg-slate-800 cursor-pointer transition-colors"
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

      {/* Typing Indicator */}
      {isSomeoneTyping && (
        <div className="px-4 py-1.5 text-xs text-amber-400/90 bg-slate-900/40 border-t border-slate-900 flex items-center gap-2">
          <div className="flex gap-1 items-center">
            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span>
            {typingUsers.map((u) => u.displayName).join(', ')} {typingUsers.length > 1 ? 'are' : 'is'} typing...
          </span>
        </div>
      )}

      {/* Replying Banner */}
      {replyingTo && (
        <div className="bg-slate-900 border-t border-slate-800 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <CornerUpLeft className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span className="text-slate-400 shrink-0">Replying to <strong className="text-slate-200">{replyingTo.senderName}</strong>:</span>
            <span className="text-slate-300 truncate">{replyingTo.text}</span>
          </div>
          <button type="button" onClick={() => setReplyingTo(null)} className="text-slate-500 hover:text-slate-300">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Selected Image Staging Banner */}
      {selectedImage && (
        <div className="bg-slate-900 border-t border-slate-800 p-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={selectedImage.dataUrl} alt="Preview" className="w-10 h-10 object-cover rounded border border-slate-700" />
            <div className="flex flex-col text-xs">
              <span className="text-slate-200 font-medium truncate max-w-[200px]">{selectedImage.name}</span>
              <span className="text-amber-500 text-[10px]">Encrypted Image Attachment Ready</span>
            </div>
          </div>
          <button type="button" onClick={() => setSelectedImage(null)} className="text-slate-500 hover:text-rose-400 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSendMessage} className="p-3 bg-slate-900/80 border-t border-slate-800 flex items-center gap-2 shrink-0">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageSelect}
          accept="image/*"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessingImage}
          className="p-2 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          title="Attach Image"
        >
          {isProcessingImage ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImageIcon className="w-5 h-5" />}
        </button>

        <input
          type="text"
          value={inputText}
          onChange={handleInputChange}
          placeholder={passphrase ? "Type encrypted message..." : "Set passcode above to send messages..."}
          disabled={!passphrase}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs sm:text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
        />

        <button
          type="submit"
          disabled={!passphrase || (!inputText.trim() && !selectedImage)}
          className="p-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-bold rounded-lg transition-colors cursor-pointer shrink-0"
        >
          <Send className="w-5 h-5" />
        </button>
      </form>

      {/* Image Modal */}
      {expandedImageUrl && (
        <div className="fixed inset-0 bg-slate-950/90 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
            <button
              type="button"
              onClick={() => setExpandedImageUrl(null)}
              className="absolute -top-10 right-0 text-slate-400 hover:text-white p-1"
            >
              <X className="w-6 h-6" />
            </button>
            <img src={expandedImageUrl} alt="Expanded preview" className="max-w-full max-h-[80vh] object-contain rounded-lg border border-slate-800" />
            <a
              href={expandedImageUrl}
              download="cypher-image.png"
              className="mt-4 px-4 py-2 bg-amber-600 text-slate-950 font-semibold rounded-lg flex items-center gap-2 text-xs"
            >
              <Download className="w-4 h-4" /> Download Original Image
            </a>
          </div>
        </div>
      )}
    </div>
  );
          }
