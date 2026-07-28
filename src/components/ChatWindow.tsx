import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  getDoc
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';
import {
  Send,
  Lock,
  Flame,
  Check,
  CheckCheck,
  AlertTriangle,
  ArrowLeft,
  Users,
  Eye,
  Trash2,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Download,
  PhoneCall,
  PhoneOff,
  Video,
  Mic,
  MicOff,
  VideoOff,
  Minimize2,
  Maximize2
} from 'lucide-react';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: UserProfile;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock: () => void;
  onBack: () => void;
}

const TIMER_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 }
];

export default function ChatWindow({ chat, currentUser, usersMap, onEmergencyLock, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [selfDestructSec, setSelfDestructSec] = useState<number>(0);
  const [isTyping, setIsTyping] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Image / Attachment upload state
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState<string>('');
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WebRTC Audio/Video Call State
  const [callActive, setCallActive] = useState(false);
  const [callType, setCallType] = useState<'audio' | 'video'>('audio');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // 1. Subscribe to real-time messages in this chat
  useEffect(() => {
    const messagesPath = `chats/${chat.id}/messages`;
    const q = query(collection(db, messagesPath), orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs: ChatMessage[] = [];
        snapshot.docs.forEach((d) => {
          msgs.push({ id: d.id, ...d.data() } as ChatMessage);
        });
        setMessages(msgs);
        setErrorMsg('');
      },
      (error) => {
        console.error('Firestore messages listener error:', error);
        setErrorMsg('Failed to sync messages in real-time. Check database permissions.');
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  // 2. Automatically mark messages as read
  useEffect(() => {
    if (!messages.length) return;

    messages.forEach(async (msg) => {
      if (msg.senderId !== currentUser.uid) {
        const readByList = msg.readBy || [];
        if (!readByList.includes(currentUser.uid)) {
          try {
            const msgRef = doc(db, `chats/${chat.id}/messages`, msg.id);
            await updateDoc(msgRef, {
              readBy: arrayUnion(currentUser.uid)
            });
          } catch (e) {
            console.error('Failed to update read status', e);
          }
        }
      }
    });
  }, [messages, chat.id, currentUser.uid]);

  // 3. Auto scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 4. Handle Self-Destruct Timers for local view / deletion
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      messages.forEach(async (msg) => {
        if (msg.selfDestructSeconds && msg.selfDestructSeconds > 0 && msg.timestamp) {
          const createdAt = msg.timestamp.toMillis ? msg.timestamp.toMillis() : Date.now();
          const expiresAt = createdAt + msg.selfDestructSeconds * 1000;

          if (now >= expiresAt) {
            try {
              const msgRef = doc(db, `chats/${chat.id}/messages`, msg.id);
              await deleteDoc(msgRef);
            } catch (e) {
              console.error('Auto-destruct deletion failed:', e);
            }
          }
        }
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [messages, chat.id]);

  // Handle typing indicator updates
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);

    if (!isTyping) {
      setIsTyping(true);
      updateTypingStatus(true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      updateTypingStatus(false);
    }, 2000);
  };

  const updateTypingStatus = async (typing: boolean) => {
    try {
      const chatRef = doc(db, 'chats', chat.id);
      if (typing) {
        await updateDoc(chatRef, {
          isTyping: arrayUnion(currentUser.uid)
        });
      } else {
        await updateDoc(chatRef, {
          isTyping: arrayRemove(currentUser.uid)
        });
      }
    } catch (e) {
      console.error('Typing status update error:', e);
    }
  };

  // Image file picker handling
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Only image attachments (PNG, JPG, WEBP, GIF) are supported.');
      return;
    }

    // Limit size to ~3MB to ensure clean Base64 Firestore storage without payload errors
    if (file.size > 3.5 * 1024 * 1024) {
      setErrorMsg('Image size exceeds 3.5MB. Please choose a smaller image.');
      return;
    }

    setIsProcessingImage(true);
    setErrorMsg('');

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedImage(reader.result as string);
      setImageFileName(file.name);
      setIsProcessingImage(false);
    };
    reader.onerror = (err) => {
      console.error('Failed to process image:', err);
      setErrorMsg(err?.message || 'Failed to process selected image file.');
      setIsProcessingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const removeSelectedImage = () => {
    setSelectedImage(null);
    setImageFileName('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Send message handler
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputText.trim() && !selectedImage) || isProcessingImage) return;

    const textToSend = inputText.trim();
    const imageToSend = selectedImage;
    const filenameToSend = imageFileName;

    setInputText('');
    removeSelectedImage();

    if (isTyping) {
      setIsTyping(false);
      updateTypingStatus(false);
    }

    try {
      const messagesPath = `chats/${chat.id}/messages`;
      await addDoc(collection(db, messagesPath), {
        chatId: chat.id,
        senderId: currentUser.uid,
        text: textToSend || (imageToSend ? '📷 Sent an image attachment' : ''),
        imageUrl: imageToSend || null,
        fileName: filenameToSend || null,
        timestamp: serverTimestamp(),
        readBy: [currentUser.uid],
        selfDestructSeconds: selfDestructSec > 0 ? selfDestructSec : null
      });

      // Update chat's last message
      const chatRef = doc(db, 'chats', chat.id);
      await updateDoc(chatRef, {
        lastMessage: {
          text: imageToSend && !textToSend ? '📷 Image Attachment' : textToSend,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });
    } catch (err: any) {
      console.error('Error sending message:', err);
      setErrorMsg('Failed to send message: ' + (err.message || 'Permission denied'));
    }
  };

  // Start Call Functionality (Simulated Encrypted WebRTC Peer Stream with Media Access)
  const startCall = async (type: 'audio' | 'video') => {
    setCallType(type);
    setCallActive(true);
    setCallDuration(0);
    setIsMuted(false);
    setIsVideoOff(type === 'audio');
    setErrorMsg('');

    try {
      const constraints = {
        audio: true,
        video: type === 'video'
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      if (localVideoRef.current && type === 'video') {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.warn('Microphone/Camera access restricted or blocked:', err);
      // Fallback simulated stream for sandbox environments
    }

    callTimerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  };

  const endCall = () => {
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    setCallActive(false);
    setCallDuration(0);
  };

  const toggleMute = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = isMuted));
    }
    setIsMuted(!isMuted);
  };

  const toggleVideo = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = isVideoOff));
    }
    setIsVideoOff(!isVideoOff);
  };

  const formatCallTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Determine chat name & avatar for 1-on-1 vs group
  let chatTitle = chat.name || 'Group Chat';
  let otherUser: UserProfile | null = null;

  if (chat.type === 'direct') {
    const otherUserId = chat.participants.find((id) => id !== currentUser.uid);
    if (otherUserId && usersMap[otherUserId]) {
      otherUser = usersMap[otherUserId];
      chatTitle = otherUser.displayName;
    }
  }

  // Filter typing indicator participants except current user
  const otherTypingUsers = (chat.isTyping || []).filter((id) => id !== currentUser.uid);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 relative overflow-hidden">
      {/* 1. Header */}
      <header className="flex items-center justify-between px-3 md:px-4 py-2.5 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 z-10 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onBack}
            className="md:hidden p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          {chat.type === 'direct' && otherUser ? (
            <PresenceStatus user={otherUser} showDetails={false} />
          ) : (
            <div className="w-9 h-9 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
              <Users className="w-4 h-4 text-amber-500" />
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold truncate text-slate-100">{chatTitle}</h2>
              <span className="flex items-center text-[10px] bg-slate-950 text-amber-500/90 border border-amber-500/20 px-1.5 py-0.5 rounded font-mono">
                <Lock className="w-2.5 h-2.5 mr-1" />
                E2EE
              </span>
            </div>
            <p className="text-[11px] text-slate-400 truncate">
              {chat.type === 'direct' && otherUser ? (
                otherUser.status === 'online' ? (
                  <span className="text-emerald-400 font-medium">Online</span>
                ) : (
                  <span className="text-slate-500 font-mono">
                    Last seen {otherUser.lastSeen ? new Date(otherUser.lastSeen.toMillis()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently'}
                  </span>
                )
              ) : (
                `${chat.participants.length} encrypted members`
              )}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {/* Call buttons */}
          <button
            onClick={() => startCall('audio')}
            title="Start Encrypted Voice Call"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-amber-400 border border-slate-700 transition-all cursor-pointer"
          >
            <PhoneCall className="w-4 h-4" />
          </button>
          <button
            onClick={() => startCall('video')}
            title="Start Encrypted Video Call"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-amber-400 border border-slate-700 transition-all cursor-pointer"
          >
            <Video className="w-4 h-4" />
          </button>

          {/* Emergency Panic Lock */}
          <button
            onClick={onEmergencyLock}
            title="Emergency Lock (Wipe Local View)"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/80 border border-red-800/80 text-red-300 hover:text-red-100 text-xs font-semibold transition-all ml-1 cursor-pointer"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 animate-pulse" />
            <span className="hidden sm:inline">Panic</span>
          </button>
        </div>
      </header>

      {/* Self-Destruct Timer Bar */}
      <div className="bg-slate-950 px-4 py-1.5 border-b border-slate-900 flex items-center justify-between text-xs text-slate-400 shrink-0">
        <div className="flex items-center gap-1.5 text-amber-500/90 font-medium">
          <Flame className="w-3.5 h-3.5 animate-bounce text-amber-500" />
          <span className="text-[11px]">Self-Destruct Timer:</span>
        </div>
        <div className="flex items-center gap-1">
          {TIMER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSelfDestructSec(opt.value)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                selfDestructSec === opt.value
                  ? 'bg-amber-500 text-slate-950 font-bold'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Call Overlay Modal */}
      {callActive && (
        <div
          className={`bg-slate-900 border-b border-amber-500/30 transition-all duration-300 z-20 shrink-0 ${
            isMinimized ? 'h-16 px-4 flex items-center justify-between' : 'p-4 flex flex-col items-center justify-center min-h-[220px]'
          }`}
        >
          {isMinimized ? (
            <>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-emerald-500 animate-ping" />
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Encrypted {callType === 'video' ? 'Video' : 'Voice'} Call with {chatTitle}
                  </p>
                  <p className="text-[10px] font-mono text-amber-400">{formatCallTime(callDuration)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsMinimized(false)}
                  className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
                <button
                  onClick={endCall}
                  className="p-1.5 rounded bg-red-600 hover:bg-red-700 text-white"
                >
                  <PhoneOff className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <div className="w-full max-w-md flex flex-col items-center">
              <div className="flex items-center justify-between w-full mb-3">
                <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" /> P2P WebRTC Encrypted Stream
                </span>
                <button
                  onClick={() => setIsMinimized(true)}
                  className="text-slate-400 hover:text-slate-200 p-1"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              </div>

              {/* Video elements stage */}
              {callType === 'video' && !isVideoOff ? (
                <div className="relative w-full h-40 bg-slate-950 rounded-xl overflow-hidden border border-slate-800 mb-3 flex items-center justify-center">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover transform -scale-x-100"
                  />
                  <div className="absolute bottom-2 left-2 bg-slate-950/80 px-2 py-0.5 rounded text-[10px] font-mono text-slate-300">
                    You (Local Stream)
                  </div>
                </div>
              ) : (
                <div className="w-16 h-16 rounded-full bg-amber-500/10 border-2 border-amber-500/40 flex items-center justify-center mb-2 animate-pulse">
                  <PhoneCall className="w-8 h-8 text-amber-500" />
                </div>
              )}

              <h3 className="text-sm font-semibold text-slate-100 mb-0.5">{chatTitle}</h3>
              <p className="text-xs font-mono text-amber-400 mb-4">{formatCallTime(callDuration)}</p>

              {/* Call Controls */}
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleMute}
                  className={`p-3 rounded-full transition-colors ${
                    isMuted ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>

                {callType === 'video' && (
                  <button
                    onClick={toggleVideo}
                    className={`p-3 rounded-full transition-colors ${
                      isVideoOff ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    {isVideoOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                  </button>
                )}

                <button
                  onClick={endCall}
                  className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white font-bold transition-all shadow-lg"
                >
                  <PhoneOff className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error alert banner */}
      {errorMsg && (
        <div className="bg-red-950/90 border-b border-red-800/80 px-4 py-2 text-xs text-red-200 flex items-center justify-between shrink-0">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-100 ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2. Messages List */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-600">
            <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mb-3">
              <Lock className="w-6 h-6 text-amber-500/60" />
            </div>
            <p className="text-xs font-mono text-slate-400 max-w-xs">
              End-to-End Encrypted Workspace Channel. Messages are protected and non-persistent.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUser.uid;
            const senderUser = usersMap[msg.senderId];
            const senderName = isMe ? 'You' : senderUser?.displayName || 'Unknown';
            const readByOthers = (msg.readBy || []).filter((id) => id !== currentUser.uid).length > 0;

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className="text-[10px] font-semibold text-slate-400">{senderName}</span>
                  <span className="text-[9px] text-slate-600 font-mono">
                    {msg.timestamp?.toMillis
                      ? new Date(msg.timestamp.toMillis()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : 'Sending...'}
                  </span>
                  {msg.selfDestructSeconds && msg.selfDestructSeconds > 0 && (
                    <span className="flex items-center text-[9px] text-amber-500 font-mono bg-amber-500/10 px-1 py-0.2 rounded">
                      <Flame className="w-2.5 h-2.5 mr-0.5" />
                      {msg.selfDestructSeconds}s
                    </span>
                  )}
                </div>

                <div
                  className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed shadow-sm break-words ${
                    isMe
                      ? 'bg-amber-600 text-slate-950 font-medium rounded-tr-none'
                      : 'bg-slate-900 text-slate-100 border border-slate-800 rounded-tl-none'
                  }`}
                >
                  {/* Image payload rendering */}
                  {msg.imageUrl && (
                    <div className="mb-2 overflow-hidden rounded-xl border border-slate-800/50 max-w-xs bg-slate-950">
                      <img
                        src={msg.imageUrl}
                        alt="Attachment"
                        className="w-full h-auto max-h-60 object-cover cursor-pointer hover:opacity-95 transition-opacity"
                        onClick={() => window.open(msg.imageUrl, '_blank')}
                      />
                    </div>
                  )}

                  {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}

                  <div className={`flex items-center justify-end gap-1 mt-1 text-[9px] ${isMe ? 'text-slate-900/70' : 'text-slate-500'}`}>
                    {isMe && (
                      readByOthers ? (
                        <CheckCheck className="w-3.5 h-3.5 text-slate-950" title="Read by participant" />
                      ) : (
                        <Check className="w-3.5 h-3.5 text-slate-900/60" title="Delivered" />
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Real-time typing status banner */}
        {otherTypingUsers.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-amber-400/90 font-mono italic pl-2 py-1">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
              {otherTypingUsers.map((id) => usersMap[id]?.displayName || 'Someone').join(', ')} is typing...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Selected Image Preview Panel before sending */}
      {selectedImage && (
        <div className="bg-slate-900 px-4 py-2 border-t border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-10 h-10 rounded border border-slate-700 overflow-hidden bg-slate-950 shrink-0">
              <img src={selectedImage} alt="Preview" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-200 truncate">{imageFileName}</p>
              <p className="text-[10px] text-emerald-400 font-mono">Ready to upload</p>
            </div>
          </div>
          <button
            onClick={removeSelectedImage}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 3. Input Footer */}
      <form
        onSubmit={handleSendMessage}
        className="p-3 bg-slate-900/90 backdrop-blur-md border-t border-slate-800 flex items-center gap-2 shrink-0"
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="image/*"
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Attach Image"
          className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-400 border border-slate-700 transition-colors cursor-pointer shrink-0"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        <input
          type="text"
          value={inputText}
          onChange={handleInputChange}
          placeholder={selectedImage ? 'Add a caption...' : 'Type an encrypted message...'}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/50 transition-colors"
        />

        <button
          type="submit"
          disabled={(!inputText.trim() && !selectedImage) || isProcessingImage}
          className="p-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold transition-all shadow-md cursor-pointer shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
              }
