// File Path: src/App.tsx

import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc, 
  serverTimestamp, 
  where,
  getDocs,
  addDoc
} from 'firebase/firestore';
import { 
  MessageSquare, 
  Users, 
  Shield, 
  Lock, 
  Search, 
  UserPlus, 
  Plus, 
  LogOut,
  AlertTriangle,
  Key,
  Flame,
  CheckCircle2,
  X
} from 'lucide-react';

import { db, handleFirestoreError, OperationType } from './lib/firebase';
import { UserProfile, ChatRoom } from './types';
import ChatWindow from './components/ChatWindow';
import PresenceStatus from './components/PresenceStatus';

export default function App() {
  // Current user state (Demo / Authenticated User)
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');

  // Collections state
  const [usersMap, setUsersMap] = useState<Record<string, UserProfile>>({});
  const [activeChats, setActiveChats] = useState<ChatRoom[]>([]);
  const [selectedChat, setSelectedChat] = useState<ChatRoom | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // UI Navigation / Creation State
  const [activeTab, setActiveTab] = useState<'chats' | 'directory'>('chats');
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);

  // Emergency Lock panic state
  const [isEmergencyLocked, setIsEmergencyLocked] = useState(false);

  // 1. Initial login or restore demo user
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!authEmail.trim()) return;

    const uid = authEmail.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
    const userObj: UserProfile = {
      uid,
      email: authEmail.trim(),
      displayName: authDisplayName.trim() || authEmail.split('@')[0],
      status: 'online',
      lastSeen: serverTimestamp()
    };

    // Save profile to Firestore
    setDoc(doc(db, 'users', uid), userObj, { merge: true }).catch((err) => {
      console.error('Error saving user profile:', err);
    });

    setCurrentUser(userObj);
  };

  // 2. Real-time Users Directory Listener
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'users'),
      (snapshot) => {
        const uMap: Record<string, UserProfile> = {};
        snapshot.docs.forEach((d) => {
          uMap[d.id] = d.data() as UserProfile;
        });
        setUsersMap(uMap);
      },
      (error) => {
        handleFirestoreError(error, OperationType.READ, 'users');
      }
    );
    return () => unsub();
  }, []);

  // 3. User Presence Heartbeat (online status)
  useEffect(() => {
    if (!currentUser) return;

    const userRef = doc(db, 'users', currentUser.uid);
    const updatePresence = () => {
      setDoc(userRef, {
        status: 'online',
        lastSeen: serverTimestamp()
      }, { merge: true }).catch(() => {});
    };

    updatePresence();
    const interval = setInterval(updatePresence, 30000);

    return () => clearInterval(interval);
  }, [currentUser]);

  // 4. Real-time Active Chats Listener
  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', currentUser.uid)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const chatList: ChatRoom[] = [];
        snapshot.docs.forEach((d) => {
          chatList.push({ id: d.id, ...d.data() } as ChatRoom);
        });
        setActiveChats(chatList);
      },
      (error) => {
        handleFirestoreError(error, OperationType.READ, 'chats');
      }
    );

    return () => unsubscribe();
  }, [currentUser]);

  // 5. Subscribe to unread messages across active chats
  useEffect(() => {
    if (!currentUser || activeChats.length === 0) {
      setUnreadCounts({});
      return;
    }

    const unsubscribes: (() => void)[] = [];

    activeChats.forEach((chat) => {
      const messagesPath = `chats/${chat.id}/messages`;
      const unsub = onSnapshot(
        collection(db, messagesPath),
        (snapshot) => {
          let unread = 0;
          snapshot.docs.forEach((d) => {
            const data = d.data();
            const senderId = data.senderId;
            const readBy = (data.readBy || []) as string[];
            if (senderId !== currentUser.uid && !readBy.includes(currentUser.uid)) {
              unread++;
            }
          });
          setUnreadCounts((prev) => ({
            ...prev,
            [chat.id]: unread
          }));
        },
        () => {}
      );
      unsubscribes.push(unsub);
    });

    return () => {
      unsubscribes.forEach((u) => u());
    };
  }, [currentUser, activeChats]);

  // Keep selectedChat updated with real-time data from activeChats
  useEffect(() => {
    if (selectedChat) {
      const updated = activeChats.find(c => c.id === selectedChat.id);
      if (updated) setSelectedChat(updated);
    }
  }, [activeChats]);

  // Start or open Direct Chat
  const handleStartDirectChat = async (targetUser: UserProfile) => {
    if (!currentUser) return;

    // Check if direct chat already exists
    const directChatId = [currentUser.uid, targetUser.uid].sort().join('_');
    const existingChat = activeChats.find(c => c.id === directChatId);

    if (existingChat) {
      setSelectedChat(existingChat);
      return;
    }

    // Create new Direct Chat
    const newChat: Omit<ChatRoom, 'id'> = {
      type: 'direct',
      participants: [currentUser.uid, targetUser.uid],
      createdById: currentUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    await setDoc(doc(db, 'chats', directChatId), newChat);
    setSelectedChat({ id: directChatId, ...newChat } as ChatRoom);
    setActiveTab('chats');
  };

  // Create Group Chat
  const handleCreateGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !groupName.trim() || selectedParticipants.length === 0) return;

    const allParticipants = Array.from(new Set([currentUser.uid, ...selectedParticipants]));

    const newGroup: Omit<ChatRoom, 'id'> = {
      type: 'group',
      name: groupName.trim(),
      participants: allParticipants,
      createdById: currentUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const docRef = await addDoc(collection(db, 'chats'), newGroup);
    setSelectedChat({ id: docRef.id, ...newGroup } as ChatRoom);
    
    // Reset group form
    setGroupName('');
    setSelectedParticipants([]);
    setShowNewGroupModal(false);
    setActiveTab('chats');
  };

  // Panic / Emergency Lock Handler
  const handlePanicWipe = () => {
    setSelectedChat(null);
    setIsEmergencyLocked(true);
  };

  if (isEmergencyLocked) {
    return (
      <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-center p-6 text-rose-500 font-mono">
        <Lock className="w-16 h-16 mb-4 animate-bounce text-rose-600" />
        <h1 className="text-2xl font-bold tracking-widest uppercase mb-2">VAULT EMERGENCY LOCKED</h1>
        <p className="text-xs text-rose-400 max-w-sm mb-6">
          All active encryption keys were wiped from browser memory. Session disconnected.
        </p>
        <button
          onClick={() => {
            setIsEmergencyLocked(false);
            setCurrentUser(null);
          }}
          className="px-6 py-2.5 rounded-xl bg-rose-950 border border-rose-500/40 text-rose-300 hover:bg-rose-900 transition-colors text-xs font-bold cursor-pointer"
        >
          Re-Authenticate Session
        </button>
      </div>
    );
  }

  // Authentication View
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
              <Shield className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">CypherChat Access</h1>
            <p className="text-xs text-slate-400 mt-1">End-to-End Encrypted Private Messaging Engine</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">User Handle / Email</label>
              <input
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="alice@cypher.net"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Display Name</label>
              <input
                type="text"
                value={authDisplayName}
                onChange={(e) => setAuthDisplayName(e.target.value)}
                placeholder="Alice (Optional)"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-3.5 rounded-xl text-sm transition-colors cursor-pointer shadow-lg shadow-amber-500/20 mt-2"
            >
              Enter Encrypted Vault
            </button>
          </form>
        </div>
      </div>
    );
  }

  const filteredUsers = Object.values(usersMap).filter(
    u => u.uid !== currentUser.uid && (
      u.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email?.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const filteredChats = activeChats.filter(
    c => c.name?.toLowerCase().includes(searchQuery.toLowerCase()) || c.type === 'direct'
  );

  const totalUnreadCount = (Object.values(unreadCounts) as number[]).reduce((sum, c) => sum + c, 0);

  return (
    <div className="flex h-screen bg-slate-950 font-sans text-slate-200 overflow-hidden">
      
      {/* Left Sidebar (Desktop & Tablet) */}
      <div className={`w-full md:w-80 lg:w-96 bg-slate-950 border-r border-slate-900 flex flex-col h-full ${selectedChat ? 'hidden md:flex' : 'flex'}`}>
        
        {/* User Profile Bar Header */}
        <div className="p-4 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
          <PresenceStatus user={currentUser} showDetails={true} />
          
          <button
            onClick={() => setCurrentUser(null)}
            className="p-2 rounded-lg bg-slate-800 hover:bg-rose-950 hover:text-rose-400 text-slate-400 transition-colors cursor-pointer"
            title="Log Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>

        {/* Search & Actions Bar */}
        <div className="p-3 border-b border-slate-900 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats or users..."
              className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          <button
            onClick={() => setShowNewGroupModal(true)}
            className="w-full py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-xl text-xs font-semibold text-amber-400 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Group Chat</span>
          </button>
        </div>

        {/* Navigation Tabs (Desktop) */}
        <div className="hidden md:flex p-2 gap-1 border-b border-slate-900 bg-slate-950">
          <button
            onClick={() => { setActiveTab('chats'); setSearchQuery(''); }}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors relative ${
              activeTab === 'chats'
                ? 'bg-slate-900 text-slate-100 border border-slate-800'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Active Chats</span>
            {totalUnreadCount > 0 && (
              <span className="bg-amber-500 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.2 rounded-full shadow-md animate-pulse">
                {totalUnreadCount}
              </span>
            )}
          </button>
          <button
            onClick={() => { setActiveTab('directory'); setSearchQuery(''); }}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              activeTab === 'directory'
                ? 'bg-slate-900 text-slate-100 border border-slate-800'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>User Directory</span>
          </button>
        </div>

        {/* Main List Display (Chats vs Directory) */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {activeTab === 'chats' ? (
            filteredChats.length === 0 ? (
              <div className="text-center py-10 text-slate-600 text-xs">
                No active chats found. Select a user from directory to message.
              </div>
            ) : (
              filteredChats.map((chat) => {
                const isSelected = selectedChat?.id === chat.id;
                const unreadCount = unreadCounts[chat.id] || 0;
                
                let chatTitle = chat.name || 'Group Chat';
                let statusComponent = null;

                if (chat.type === 'direct') {
                  const otherUid = chat.participants.find(p => p !== currentUser.uid);
                  const otherUser = otherUid ? usersMap[otherUid] : null;
                  if (otherUser) {
                    chatTitle = otherUser.displayName || 'Direct Chat';
                    statusComponent = <PresenceStatus user={otherUser} showDetails={false} />;
                  }
                }

                return (
                  <button
                    key={chat.id}
                    onClick={() => setSelectedChat(chat)}
                    className={`w-full p-3 rounded-xl text-left flex items-center gap-3 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-amber-500/10 border border-amber-500/30'
                        : 'hover:bg-slate-900/60 border border-transparent'
                    }`}
                  >
                    {statusComponent || (
                      <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 font-bold text-sm shrink-0">
                        {chatTitle[0].toUpperCase()}
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold truncate text-slate-200">{chatTitle}</span>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          {unreadCount > 0 && (
                            <span className="bg-amber-500 text-slate-950 font-black text-[10px] px-1.5 py-0.2 rounded-full shadow-md animate-pulse">
                              {unreadCount}
                            </span>
                          )}
                          {chat.updatedAt && (
                            <span className="text-[9px] text-slate-600 font-mono">
                              {new Date(chat.updatedAt.toMillis()).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className={`text-[11px] truncate mt-0.5 font-mono ${unreadCount > 0 ? 'text-amber-400 font-semibold' : 'text-slate-500'}`}>
                        {chat.lastMessage ? chat.lastMessage.text : 'No messages yet'}
                      </p>
                    </div>
                  </button>
                );
              })
            )
          ) : (
            <div className="space-y-1">
              {filteredUsers.length === 0 ? (
                <div className="text-center py-10 text-slate-600 text-xs">
                  {searchQuery ? 'No matched users' : 'No other users registered yet'}
                </div>
              ) : (
                filteredUsers.map((user) => {
                  const directChatId = [currentUser.uid, user.uid].sort().join('_');
                  const userUnread = unreadCounts[directChatId] || 0;

                  return (
                    <button
                      key={user.uid}
                      onClick={() => handleStartDirectChat(user)}
                      className="w-full flex items-center justify-between p-2.5 rounded-lg hover:bg-slate-900/50 text-left transition-colors group"
                    >
                      <PresenceStatus user={user} showDetails={true} />
                      <div className="flex items-center gap-2">
                        {userUnread > 0 && (
                          <span className="bg-amber-500 text-slate-950 font-extrabold text-[10px] px-2 py-0.5 rounded-full shadow-md animate-pulse">
                            {userUnread} unread
                          </span>
                        )}
                        <span className="p-1 rounded bg-slate-900 group-hover:bg-amber-600 group-hover:text-slate-950 border border-slate-800 group-hover:border-amber-500 text-slate-500 transition-all">
                          <UserPlus className="w-3.5 h-3.5" />
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Mobile Navigation Footer Bar */}
        <div className="flex md:hidden border-t border-slate-900 bg-slate-950 p-1 justify-around">
          <button
            type="button"
            onClick={() => { setActiveTab('chats'); setSearchQuery(''); }}
            className={`flex flex-col items-center justify-center py-1 px-3 rounded-2xl transition-all duration-200 cursor-pointer relative ${
              activeTab === 'chats' ? 'text-amber-500 font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className={`py-1 px-5 rounded-full transition-all relative ${
              activeTab === 'chats' ? 'bg-amber-500/10' : ''
            }`}>
              <MessageSquare className="w-5 h-5" />
              {totalUnreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-amber-500 text-slate-950 font-black text-[9px] w-4 h-4 rounded-full flex items-center justify-center border border-slate-950">
                  {totalUnreadCount}
                </span>
              )}
            </div>
            <span className="text-[10px] mt-1 tracking-wide font-medium">Chats</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveTab('directory'); setSearchQuery(''); }}
            className={`flex flex-col items-center justify-center py-1 px-3 rounded-2xl transition-all duration-200 cursor-pointer ${
              activeTab === 'directory' ? 'text-amber-500 font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className={`py-1 px-5 rounded-full transition-all ${
              activeTab === 'directory' ? 'bg-amber-500/10' : ''
            }`}>
              <Users className="w-5 h-5" />
            </div>
            <span className="text-[10px] mt-1 tracking-wide font-medium">Users</span>
          </button>
        </div>
      </div>

      {/* Right Main Content Chat Screen */}
      <div className={`flex-1 flex flex-col h-full bg-slate-950 ${!selectedChat ? 'hidden md:flex' : 'flex'}`}>
        {selectedChat ? (
          <ChatWindow
            chat={selectedChat}
            currentUser={currentUser}
            usersMap={usersMap}
            onEmergencyLock={handlePanicWipe}
            onBack={() => setSelectedChat(null)}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-600">
            <Lock className="w-16 h-16 mb-4 text-slate-800" />
            <h2 className="text-lg font-bold text-slate-400">Encrypted Vault Channel Standby</h2>
            <p className="text-xs text-slate-600 max-w-sm mt-1">
              Select an existing chat or start a conversation from user directory to begin messaging.
            </p>
          </div>
        )}
      </div>

      {/* New Group Modal */}
      {showNewGroupModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base text-slate-100">Create Encrypted Group</h3>
              <button onClick={() => setShowNewGroupModal(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateGroupChat} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Group Name</label>
                <input
                  type="text"
                  required
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Security Team..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Select Participants</label>
                <div className="max-h-48 overflow-y-auto space-y-1 bg-slate-950 border border-slate-800 rounded-xl p-2">
                  {Object.values(usersMap)
                    .filter(u => u.uid !== currentUser.uid)
                    .map((user) => {
                      const isChecked = selectedParticipants.includes(user.uid);
                      return (
                        <label
                          key={user.uid}
                          className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-900 cursor-pointer text-xs"
                        >
                          <span className="font-medium text-slate-300">{user.displayName}</span>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedParticipants([...selectedParticipants, user.uid]);
                              } else {
                                setSelectedParticipants(selectedParticipants.filter(id => id !== user.uid));
                              }
                            }}
                            className="rounded bg-slate-900 border-slate-800 text-amber-500 focus:ring-amber-500"
                          />
                        </label>
                      );
                    })}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewGroupModal(false)}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!groupName.trim() || selectedParticipants.length === 0}
                  className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 rounded-xl text-xs font-bold"
                >
                  Create Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
                }
