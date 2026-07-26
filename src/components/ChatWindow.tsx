import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, updateProfile } from 'firebase/auth';
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  doc,
  setDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Plus,
  Users,
  UserPlus,
  LogOut,
  MessageSquare,
  Search,
  Hash,
  AlertCircle,
  Settings
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType, signInWithGoogle, logOut } from './lib/firebase';
import { ChatRoom, UserProfile } from './types';
import ChatWindow from './components/ChatWindow';
import PresenceStatus from './components/PresenceStatus';
import PinLockView from './components/PinLockView';

export default function App() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // Realtime global users mapping
  const [usersMap, setUsersMap] = useState<Record<string, UserProfile>>({});
  const [activeChats, setActiveChats] = useState<ChatRoom[]>([]);
  const [selectedChat, setSelectedChat] = useState<ChatRoom | null>(null);

  // UI Navigation / Creation State
  const [activeTab, setActiveTab] = useState<'chats' | 'directory'>('chats');
  const [searchQuery, setSearchQuery] = useState('');

  // PIN lock settings
  const [savedPin, setSavedPin] = useState<string | null>(() => localStorage.getItem('app_pin'));
  const [isAppLocked, setIsAppLocked] = useState<boolean>(() => !!localStorage.getItem('app_pin'));

  const handleSetPin = (newPin: string) => {
    localStorage.setItem('app_pin', newPin);
    setSavedPin(newPin);
    setIsAppLocked(false);
  };

  const handleResetPin = () => {
    localStorage.removeItem('app_pin');
    setSavedPin(null);
    setIsAppLocked(true);
  };

  const handleLockApp = () => {
    setIsAppLocked(true);
  };
  
  // Group creation modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedGroupParticipants, setSelectedGroupParticipants] = useState<string[]>([]);

  // Settings modal state
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPhotoURL, setNewPhotoURL] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState(false);

  // Active user profile block from our Firestore usersMap
  const myProfile = currentUser ? usersMap[currentUser.uid] : null;

  useEffect(() => {
    if (myProfile) {
      setNewDisplayName(myProfile.displayName || '');
      setNewPhotoURL(myProfile.photoURL || '');
    }
  }, [myProfile, showSettingsModal]);

  // 1. Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Sync/Create User Profile document in Firestore
        try {
          const userRef = doc(db, 'users', user.uid);
          await setDoc(userRef, {
            uid: user.uid,
            displayName: user.displayName || 'Anonymous',
            photoURL: user.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user.displayName || 'Anon')}`,
            email: user.email || '',
            status: 'online',
            lastSeen: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.error('Error registering user profile:', error);
        }
        setCurrentUser(user);
      } else {
        setCurrentUser(null);
      }
      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // 2. Real-time Heartbeat & Presence logic (Firestore)
  useEffect(() => {
    if (!currentUser) return;

    // Helper: Mark online in Firestore
    const updateOnline = async () => {
      try {
        const userRef = doc(db, 'users', currentUser.uid);
        await setDoc(userRef, {
          uid: currentUser.uid,
          displayName: currentUser.displayName || 'Anonymous',
          photoURL: currentUser.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(currentUser.displayName || 'Anon')}`,
          email: currentUser.email || '',
          status: 'online',
          lastSeen: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error('Presence online update failed:', err);
      }
    };

    // Helper: Mark offline in Firestore
    const updateOffline = async () => {
      try {
        const userRef = doc(db, 'users', currentUser.uid);
        await setDoc(userRef, {
          uid: currentUser.uid,
          displayName: currentUser.displayName || 'Anonymous',
          photoURL: currentUser.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(currentUser.displayName || 'Anon')}`,
          email: currentUser.email || '',
          status: 'offline',
          lastSeen: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error('Presence offline update failed:', err);
      }
    };

    // Trigger initial online flag
    updateOnline();

    // Start 45-second periodic heartbeat interval
    const interval = setInterval(updateOnline, 45000);

    // Visibility and unload listeners
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        updateOffline();
      } else {
        updateOnline();
      }
    };

    window.addEventListener('beforeunload', updateOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', updateOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Fallback mark offline on unmount
      updateOffline();
    };
  }, [currentUser]);

  // 3. Realtime subscribe to all User Profiles (for directory and mapping)
  useEffect(() => {
    if (!currentUser) return;

    const usersPath = 'users';
    const unsubscribe = onSnapshot(
      collection(db, usersPath),
      (snapshot) => {
        const map: Record<string, UserProfile> = {};
        snapshot.docs.forEach((doc) => {
          const profile = doc.data() as UserProfile;
          map[profile.uid] = profile;
        });
        setUsersMap(map);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, usersPath);
      }
    );

    return () => unsubscribe();
  }, [currentUser]);

  // 4. Realtime subscribe to all active Chats that current user is a participant of
  useEffect(() => {
    if (!currentUser) return;

    const chatsPath = 'chats';
    const q = query(
      collection(db, chatsPath),
      where('participantIds', 'array-contains', currentUser.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rooms = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatRoom[];
        setActiveChats(rooms);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, chatsPath);
      }
    );

    return () => unsubscribe();
  }, [currentUser]);

  // Keep selectedChat updated with real-time data from activeChats (e.g. for isTyping indicators)
  useEffect(() => {
    if (selectedChat) {
      const updated = activeChats.find(c => c.id === selectedChat.id);
      if (updated) {
        setSelectedChat(updated);
      }
    }
  }, [activeChats, selectedChat?.id]);

  // Auth Action handlers
  const handleLogin = async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Sign-in failed:', err);
    }
  };

  const handleLogout = async () => {
    if (currentUser) {
      try {
        // Explicitly set offline first
        const userRef = doc(db, 'users', currentUser.uid);
        await setDoc(userRef, {
          status: 'offline',
          lastSeen: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error('Failed to flag offline before sign-out', err);
      }
    }
    await logOut();
    setSelectedChat(null);
  };

  // Direct Chat Creator
  const handleStartDirectChat = async (recipient: UserProfile) => {
    if (!currentUser) return;

    // Use sorted combined UIDs to enforce single, deterministic direct chat (Query Enforcer)
    const combinedId = [currentUser.uid, recipient.uid].sort().join('_');

    const chatRef = doc(db, 'chats', combinedId);
    
    const initialPayload: ChatRoom = {
      id: combinedId,
      type: 'direct',
      participantIds: [currentUser.uid, recipient.uid],
      createdAt: serverTimestamp() as any,
      updatedAt: serverTimestamp() as any
    };

    try {
      await setDoc(chatRef, initialPayload, { merge: true });
      // Transition select
      const resolvedChat: ChatRoom = {
        ...initialPayload,
        createdAt: initialPayload.createdAt || Timestamp.now() as any,
        updatedAt: initialPayload.updatedAt || Timestamp.now() as any
      };
      setSelectedChat(resolvedChat);
      setActiveTab('chats');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${combinedId}`);
    }
  };

  // Group Chat Creator
  const handleCreateGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || selectedGroupParticipants.length === 0) return;

    const allParticipantIds = [currentUser.uid, ...selectedGroupParticipants];
    const groupId = doc(collection(db, 'chats')).id;

    const initialPayload: ChatRoom = {
      id: groupId,
      name: groupName.trim(),
      type: 'group',
      participantIds: allParticipantIds,
      createdAt: serverTimestamp() as any,
      updatedAt: serverTimestamp() as any
    };

    try {
      await setDoc(doc(db, 'chats', groupId), initialPayload);
      setGroupName('');
      setSelectedGroupParticipants([]);
      setShowGroupModal(false);
      setSelectedChat(initialPayload);
      setActiveTab('chats');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${groupId}`);
    }
  };

  const toggleGroupParticipant = (uid: string) => {
    if (selectedGroupParticipants.includes(uid)) {
      setSelectedGroupParticipants(selectedGroupParticipants.filter((id) => id !== uid));
    } else {
      setSelectedGroupParticipants([...selectedGroupParticipants, uid]);
    }
  };

  // Directories Filters
  const otherUsers = (Object.values(usersMap) as UserProfile[]).filter((u) => u.uid !== currentUser?.uid);
  
  const filteredUsers = otherUsers.filter((u) => {
    const query = searchQuery.toLowerCase();
    return (
      u.displayName.toLowerCase().includes(query) ||
      u.email.toLowerCase().includes(query)
    );
  });

  const filteredChats = activeChats.filter((chat) => {
    if (chat.type === 'direct') {
      const recipientId = chat.participantIds.find((id) => id !== currentUser?.uid);
      const recipient = recipientId ? usersMap[recipientId] : null;
      return recipient?.displayName.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return chat.name?.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Render Loader State
  if (authLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-100">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-8 h-8 text-amber-500 animate-spin" />
          <span className="text-xl font-bold tracking-tight">CypherChat</span>
        </div>
        <p className="text-xs text-slate-500 font-mono">Initializing client cryptographic environment...</p>
      </div>
    );
  }

  // Render Login state
  if (!currentUser) {
    return (
      <div className="flex flex-col lg:flex-row min-h-screen bg-slate-950">
        {/* Left column info / branding */}
        <div className="flex-1 flex flex-col justify-center p-8 lg:p-16 border-b lg:border-b-0 lg:border-r border-slate-900 bg-gradient-to-br from-slate-950 via-slate-950 to-amber-950/20">
          <div className="max-w-md mx-auto lg:mx-0">
            <div className="flex items-center gap-2.5 mb-8">
              <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <ShieldCheck className="w-8 h-8 text-amber-500" />
              </div>
              <span className="text-2xl font-bold tracking-tight text-slate-100">CypherChat</span>
            </div>

            <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight text-slate-100 leading-tight mb-4">
              True Client-Side <span className="text-amber-500">End-to-End Encrypted</span> Messaging.
            </h1>
            
            <p className="text-slate-400 text-sm leading-relaxed mb-6">
              CypherChat guarantees absolute mathematical privacy. Your keys and passphrases remain strictly inside your browser. No unencrypted content ever touches Firestore.
            </p>

            <div className="space-y-4 font-mono text-xs text-slate-500 border-l-2 border-slate-800 pl-4 py-1">
              <div className="flex gap-2">
                <span className="text-amber-500">✓</span>
                <span>AES-GCM 256-bit symmetric encryption</span>
              </div>
              <div className="flex gap-2">
                <span className="text-amber-500">✓</span>
                <span>PBKDF2 key derivation with 100k rounds</span>
              </div>
              <div className="flex gap-2">
                <span className="text-amber-500">✓</span>
                <span>Realtime Firestore presence heartbeat status</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column Google OAuth action */}
        <div className="flex-1 flex items-center justify-center p-8 bg-slate-950">
          <div className="w-full max-w-sm text-center space-y-6">
            <div className="inline-flex p-4 rounded-full bg-slate-900 border border-slate-800">
              <Lock className="w-10 h-10 text-slate-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-200">Secure Vault Access</h2>
              <p className="text-xs text-slate-500 mt-1">Authenticate using Google Identity to sync your directory.</p>
            </div>

            <button
              onClick={handleLogin}
              className="w-full bg-slate-100 text-slate-900 hover:bg-slate-200 font-semibold px-5 py-3 rounded-xl shadow-md flex items-center justify-center gap-3 transition-all focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Sign in with Google</span>
            </button>

            <p className="text-[10px] text-slate-600 leading-relaxed">
              By authenticating, your public profile (display name, avatar, and email) is cached to let others initiate E2E encrypted threads with you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Profile settings state and hooks are declared at the top of the component to comply with React rules of hooks

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDisplayName.trim()) {
      setSettingsError('Display name cannot be empty');
      return;
    }
    setSavingSettings(true);
    setSettingsError('');
    setSettingsSuccess(false);

    try {
      // 1. Update Firebase Auth user profile representation
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, {
          displayName: newDisplayName.trim(),
          photoURL: newPhotoURL.trim()
        });
      }

      // 2. Synchronize user document to Firestore
      const userRef = doc(db, 'users', currentUser.uid);
      await setDoc(userRef, {
        displayName: newDisplayName.trim(),
        photoURL: newPhotoURL.trim()
      }, { merge: true });

      setSettingsSuccess(true);
      setTimeout(() => {
        setSettingsSuccess(false);
        setShowSettingsModal(false);
      }, 1200);
    } catch (err: any) {
      console.error('Failed to update profile settings:', err);
      setSettingsError(err.message || 'Failed to save changes. Please try again.');
    } finally {
      setSavingSettings(false);
    }
  };

  // Render PIN lock if enabled and locked, or if not configured yet
  if (currentUser && (isAppLocked || !savedPin)) {
    return (
      <PinLockView
        savedPin={savedPin}
        onSuccess={(pin) => setIsAppLocked(false)}
        onSetPin={handleSetPin}
        onResetPin={handleResetPin}
      />
    );
  }



  return (
    <div className="flex h-screen bg-slate-950 font-sans text-slate-200 overflow-hidden">
      {/* 1. Sidebar Panel */}
      <div className={`w-full md:w-80 border-r border-slate-900 bg-slate-950 flex flex-col h-full shrink-0 relative ${selectedChat ? 'hidden md:flex' : 'flex'}`}>
        
        {/* Workspace Branding Header */}
        <div className="p-4 border-b border-slate-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-amber-500" />
            <span className="font-bold tracking-tight text-slate-100">CypherChat</span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowSettingsModal(true)}
              title="Profile Settings"
              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-500 hover:bg-slate-900 transition-all duration-150 cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleLockApp}
              title="Lock CypherChat workspace"
              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-500 hover:bg-slate-900 transition-all duration-150 cursor-pointer"
            >
              <Lock className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleLogout}
              title="Sign out of system"
              className="p-1.5 rounded-lg text-slate-500 hover:text-rose-500 hover:bg-slate-900 transition-all duration-150 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Current user micro status card */}
        <div className="px-4 py-3 border-b border-slate-900 bg-slate-900/10 flex items-center justify-between">
          {myProfile ? (
            <PresenceStatus user={myProfile} showDetails={true} />
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-slate-800 animate-pulse" />
              <div className="space-y-1">
                <div className="w-20 h-3 bg-slate-800 rounded animate-pulse" />
                <div className="w-10 h-2 bg-slate-800 rounded animate-pulse" />
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="text-[9px] font-mono text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 px-2 py-0.5 rounded-full uppercase cursor-pointer flex items-center gap-1 transition-all"
            title="Edit Profile"
          >
            <span>Edit</span>
          </button>
        </div>

        {/* Navigation Tabs - Hidden on mobile in favor of bottom navigation */}
        <div className="hidden md:flex p-2 gap-1 border-b border-slate-900 bg-slate-950">
          <button
            onClick={() => { setActiveTab('chats'); setSearchQuery(''); }}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              activeTab === 'chats'
                ? 'bg-slate-900 text-slate-100 border border-slate-800'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Active Chats</span>
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
            <span>Directory</span>
          </button>
        </div>

        {/* Directory/Chats Live Search Bar */}
        <div className="p-3 border-b border-slate-900">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-600" />
            <input
              type="text"
              placeholder={activeTab === 'chats' ? 'Search conversations...' : 'Search public directory...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* Sidebar scrolling content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'chats' ? (
            <div className="p-2 space-y-1">
              <div className="flex items-center justify-between px-2 py-1 mb-2">
                <span className="text-[10px] font-mono tracking-wider text-slate-500 uppercase">Conversations</span>
                <button
                  onClick={() => setShowGroupModal(true)}
                  className="p-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-100 border border-slate-800 transition-colors"
                  title="Create group chat"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {filteredChats.length === 0 ? (
                <div className="text-center py-8 text-slate-600 text-xs">
                  {searchQuery ? 'No matched conversations' : 'No active chats. Start one from the Directory tab!'}
                </div>
              ) : (
                filteredChats.map((chat) => {
                  const isSelected = selectedChat?.id === chat.id;
                  
                  let chatTitle = chat.name || 'Group Chat';
                  let statusComponent = null;

                  if (chat.type === 'direct') {
                    const recipientId = chat.participantIds.find((id) => id !== currentUser.uid);
                    const recipient = recipientId ? usersMap[recipientId] : null;
                    chatTitle = recipient?.displayName || 'Direct Chat';
                    if (recipient) {
                      statusComponent = <PresenceStatus user={recipient} className="scale-90" />;
                    }
                  } else {
                    statusComponent = (
                      <div className="w-8 h-8 rounded-full bg-indigo-950 text-indigo-400 border border-indigo-900 flex items-center justify-center shrink-0">
                        <Hash className="w-4 h-4" />
                      </div>
                    );
                  }

                  return (
                    <button
                      key={chat.id}
                      onClick={() => setSelectedChat(chat)}
                      className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors ${
                        isSelected
                          ? 'bg-amber-500/10 border border-amber-500/20 text-slate-100'
                          : 'hover:bg-slate-900/50 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {statusComponent}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold truncate text-slate-200">{chatTitle}</span>
                          {chat.updatedAt && (
                            <span className="text-[9px] text-slate-600 font-mono">
                              {new Date(chat.updatedAt.toMillis()).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 truncate mt-0.5 font-mono">
                          {chat.lastMessage ? chat.lastMessage.text : 'No messages yet'}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          ) : (
            // Public Users Directory tab
            <div className="p-2 space-y-1">
              <span className="block px-2 py-1 text-[10px] font-mono tracking-wider text-slate-500 uppercase mb-2">
                All Platform Users ({filteredUsers.length})
              </span>

              {filteredUsers.length === 0 ? (
                <div className="text-center py-8 text-slate-600 text-xs">
                  {searchQuery ? 'No matched users' : 'No other users registered yet'}
                </div>
              ) : (
                filteredUsers.map((user) => (
                  <button
                    key={user.uid}
                    onClick={() => handleStartDirectChat(user)}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg hover:bg-slate-900/50 text-left transition-colors group"
                  >
                    <PresenceStatus user={user} showDetails={true} />
                    <span className="p-1 rounded bg-slate-900 group-hover:bg-amber-600 group-hover:text-slate-950 border border-slate-800 group-hover:border-amber-500 text-slate-500 transition-all">
                      <UserPlus className="w-3.5 h-3.5" />
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Floating Action Button (FAB) for mobile - Material Design styled */}
        {activeTab === 'chats' && (
          <button
            onClick={() => setShowGroupModal(true)}
            className="md:hidden fixed bottom-20 right-6 w-14 h-14 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-full flex items-center justify-center shadow-xl shadow-amber-500/20 active:scale-95 transition-all duration-150 z-40 border border-amber-400 cursor-pointer"
            title="Create group chat"
          >
            <Plus className="w-6 h-6 stroke-[3]" />
          </button>
        )}

        {/* Bottom Navigation Bar for Mobile */}
        <div className="md:hidden flex items-center justify-around border-t border-slate-900 bg-slate-950 px-2 py-2">
          <button
            type="button"
            onClick={() => { setActiveTab('chats'); setSearchQuery(''); }}
            className={`flex flex-col items-center justify-center py-1 px-3 rounded-2xl transition-all duration-200 cursor-pointer ${
              activeTab === 'chats' ? 'text-amber-500 font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className={`py-1 px-5 rounded-full transition-all ${
              activeTab === 'chats' ? 'bg-amber-500/10' : ''
            }`}>
              <MessageSquare className="w-5 h-5" />
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
            <span className="text-[10px] mt-1 tracking-wide font-medium">Directory</span>
          </button>

          <button
            type="button"
            onClick={handleLockApp}
            className="flex flex-col items-center justify-center py-1 px-3 rounded-2xl text-slate-400 hover:text-amber-500 transition-all duration-200 cursor-pointer"
          >
            <div className="py-1 px-5 rounded-full">
              <Lock className="w-5 h-5" />
            </div>
            <span className="text-[10px] mt-1 tracking-wide font-medium">Lock</span>
          </button>
        </div>
      </div>

      {/* 2. Main Chat Workspace Area */}
      <div className={`flex-1 flex flex-col h-full bg-slate-950 ${selectedChat ? 'flex' : 'hidden md:flex'}`}>
        {selectedChat ? (
          <div className="h-full p-0 md:p-4">
            <ChatWindow
              chat={selectedChat}
              currentUser={currentUser}
              usersMap={usersMap}
              onEmergencyLock={handleLockApp}
              onBack={() => setSelectedChat(null)}
            />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-slate-950/20">
            <div className="max-w-md space-y-4">
              <div className="inline-flex p-4 rounded-3xl bg-slate-900/80 border border-slate-800 text-slate-500 animate-pulse">
                <Lock className="w-14 h-14" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold tracking-tight text-slate-100">Client-Side E2E Crypto Tunnel</h2>
                <p className="text-xs text-slate-400 leading-relaxed max-w-sm mx-auto">
                  Select a participant from the directory to start an End-to-End encrypted conversation, or join an active room.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 max-w-xs mx-auto text-[10px] font-mono text-slate-500 pt-4 border-t border-slate-900">
                <div className="flex flex-col items-center p-2 rounded bg-slate-900/40 border border-slate-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-500 mb-1" />
                  <span>No Server Logs</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-slate-900/40 border border-slate-900">
                  <Shield className="w-4 h-4 text-amber-500 mb-1" />
                  <span>SubtleCrypto</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-slate-900/40 border border-slate-900">
                  <ShieldAlert className="w-4 h-4 text-indigo-500 mb-1" />
                  <span>Zero Trust</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. Group Creation Overlay Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-scaleUp">
            
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-amber-500" />
                <h3 className="font-bold text-slate-100 text-sm">Create Encrypted Group</h3>
              </div>
              <button
                onClick={() => { setShowGroupModal(false); setGroupName(''); setSelectedGroupParticipants([]); }}
                className="text-slate-500 hover:text-slate-300 text-xs font-semibold"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleCreateGroupChat} className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Group Name</label>
                <input
                  type="text"
                  required
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="e.g. Project Cipher"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">
                  Select Members ({selectedGroupParticipants.length})
                </label>
                <div className="max-h-48 overflow-y-auto bg-slate-950 rounded-lg p-2 border border-slate-800 space-y-1">
                  {otherUsers.length === 0 ? (
                    <div className="text-center py-4 text-slate-600 text-xs">No users available</div>
                  ) : (
                    otherUsers.map((user) => {
                      const isChecked = selectedGroupParticipants.includes(user.uid);
                      return (
                        <button
                          type="button"
                          key={user.uid}
                          onClick={() => toggleGroupParticipant(user.uid)}
                          className={`w-full flex items-center justify-between p-2 rounded-md text-left transition-colors ${
                            isChecked ? 'bg-amber-500/10 text-slate-100' : 'hover:bg-slate-900/60 text-slate-400'
                          }`}
                        >
                          <PresenceStatus user={user} showDetails={true} />
                          <div className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                            isChecked ? 'bg-amber-500 border-amber-500 text-slate-950' : 'border-slate-700'
                          }`}>
                            {isChecked && <span className="text-[10px] font-bold">✓</span>}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={!groupName.trim() || selectedGroupParticipants.length === 0}
                  className="w-full bg-amber-600 text-slate-950 font-semibold py-2 rounded-lg text-sm hover:bg-amber-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Assemble Secured Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 4. Settings Overlay Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-scaleUp">
            
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/20">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-amber-500" />
                <h3 className="font-bold text-slate-100 text-sm">Profile Settings</h3>
              </div>
              <button
                type="button"
                onClick={() => { setShowSettingsModal(false); setSettingsError(''); }}
                className="text-slate-500 hover:text-slate-300 text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="p-4 space-y-4">
              {settingsError && (
                <div className="flex items-center gap-2 text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{settingsError}</span>
                </div>
              )}

              {settingsSuccess && (
                <div className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-xs">
                  <ShieldCheck className="w-4 h-4 shrink-0 animate-bounce" />
                  <span>Profile updated successfully!</span>
                </div>
              )}

              {/* Avatar Preview */}
              <div className="flex flex-col items-center py-2">
                <div className="relative group">
                  <img
                    src={newPhotoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(newDisplayName || 'Anon')}`}
                    alt="Preview"
                    className="w-20 h-20 rounded-full border-2 border-amber-500/50 bg-slate-800 object-cover shadow-lg"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute inset-0 rounded-full bg-slate-950/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-[10px] text-slate-300 font-medium">
                    Preview
                  </div>
                </div>
                <span className="text-[10px] text-slate-500 mt-2 font-mono">Current Identity Image</span>
              </div>

              {/* Display Name Input */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Display Name</label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Your display name"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              {/* Preset Avatar Selection */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Choose a Cyber Avatar</label>
                <div className="grid grid-cols-4 gap-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                  {[
                    { name: 'Cyber Scout', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=cyber-scout&backgroundColor=f59e0b' },
                    { name: 'Neon Oracle', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=neon-oracle&backgroundColor=3b82f6' },
                    { name: 'Shadow Ghost', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=shadow-ghost&backgroundColor=6366f1' },
                    { name: 'Matrix Pixels', url: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=matrix&backgroundColor=10b981' },
                    { name: 'Retro Arcade', url: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=retro-arcade&backgroundColor=ec4899' },
                    { name: 'Quantum Mind', url: 'https://api.dicebear.com/7.x/shapes/svg?seed=quantum&backgroundColor=8b5cf6' },
                    { name: 'Cosmic Glow', url: 'https://api.dicebear.com/7.x/shapes/svg?seed=cosmic&backgroundColor=ef4444' },
                    { name: 'Initials', url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(newDisplayName || 'Anon')}` },
                  ].map((preset, idx) => {
                    const isSelected = newPhotoURL === preset.url || 
                      (preset.name === 'Initials' && (!newPhotoURL || newPhotoURL.startsWith('https://api.dicebear.com/7.x/initials')));
                    return (
                      <button
                        type="button"
                        key={idx}
                        title={preset.name}
                        onClick={() => setNewPhotoURL(preset.url)}
                        className={`p-1 rounded-md border transition-all relative overflow-hidden flex items-center justify-center cursor-pointer ${
                          isSelected 
                            ? 'border-amber-500 bg-amber-500/10 scale-105' 
                            : 'border-slate-800 hover:border-slate-700 bg-slate-900'
                        }`}
                      >
                        <img
                          src={preset.url}
                          alt={preset.name}
                          className="w-10 h-10 rounded-full bg-slate-800 object-cover"
                          referrerPolicy="no-referrer"
                        />
                        {isSelected && (
                          <div className="absolute top-0 right-0 bg-amber-500 text-slate-950 text-[8px] font-bold px-1 rounded-bl">
                            ✓
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom Avatar URL input */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Custom Avatar URL</label>
                <input
                  type="url"
                  value={newPhotoURL}
                  onChange={(e) => setNewPhotoURL(e.target.value)}
                  placeholder="https://example.com/avatar.png"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 placeholder-slate-700 focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
                />
                <p className="text-[10px] text-slate-600 mt-1 leading-normal">
                  Provide a secure https URL to any image to set it as your custom avatar.
                </p>
              </div>

              {/* Submit Action */}
              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => { setShowSettingsModal(false); setSettingsError(''); }}
                  className="flex-1 bg-slate-800 text-slate-300 font-semibold py-2 rounded-lg text-xs hover:bg-slate-700 transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSettings || !newDisplayName.trim()}
                  className="flex-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold py-2 rounded-lg text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {savingSettings ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Save Changes</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

