# Security Specification and Threat Model

This document outlines the security invariants, threat vector payloads ("The Dirty Dozen"), and the defense-in-depth architecture of our chat application's Firestore security rules.

## 1. Core Data Invariants

1. **User Identity Invariant**: A user can only create or edit their own profile document (`/users/{userId}`). They cannot change their email address or spoof their own identity.
2. **Chat Room Membership Invariant**: A user can only see, read from, or write to a chat room (`/chats/{chatId}`) if their authenticated UID is present in the `participantIds` list of that specific chat.
3. **No Ransom ID Poisoning**: All custom document IDs must be verified using `isValidId` patterns (`^[a-zA-Z0-9_\-]+$`) to prevent massive, illegal string injection attacks.
4. **Message Authenticity**: A user can only send a message in a chat room where they are a member. The message's `senderId` must exactly match the authenticated `request.auth.uid`.
5. **Message Immutability**: Messages cannot be edited or deleted once written. This ensures cryptographic audit integrity for end-to-end encrypted chats.
6. **Temporal Authenticity**: All creation timestamps (`createdAt`, `timestamp`) and update timestamps (`updatedAt`, `lastSeen`) must be verified using Firestore's server-driven `request.time`. Client-supplied local clock values are rejected.
7. **Volumetric Size Constraint**: Payload fields such as `ciphertext`, `displayName`, and `photoURL` must be strictly bounded in length (`.size()`) to prevent Denial of Wallet storage exhaustion.

---

## 2. The Dirty Dozen Threat Vectors (Malicious Payloads)

Below are twelve crafted JSON payloads representing malicious attempts to violate the security invariants of our platform. Our Firestore security rules are mathematically structured to deny all twelve of these operations.

### Thread 1: Identity Spoofing & Profiling
#### Payload 1: Hijack Another User's Profile (Spoof ID)
*   **Target Path**: `/users/attacker_uid_123`
*   **Operation**: `create` or `update`
*   **Intention**: Attempt to write another user's profile where the UID doesn't match the authenticated user.
```json
{
  "uid": "victim_uid_999",
  "displayName": "Spoofed Victim",
  "email": "victim@example.com",
  "status": "online",
  "lastSeen": "2026-07-18T18:50:00Z"
}
```
*   **Result**: **DENIED** (Enforced by matching `userId == request.auth.uid` and `incoming().uid == request.auth.uid`).

#### Payload 2: Self-Promotion to Admin Role
*   **Target Path**: `/users/attacker_uid_123`
*   **Operation**: `update`
*   **Intention**: Attempt to inject a shadow admin flag or state field that does not belong in the user blueprint.
```json
{
  "uid": "attacker_uid_123",
  "displayName": "Attacker",
  "email": "attacker@example.com",
  "status": "online",
  "lastSeen": "2026-07-18T18:50:00Z",
  "isAdmin": true,
  "role": "administrator"
}
```
*   **Result**: **DENIED** (Enforced by strict keys check `data.keys().size() == 5` and `.affectedKeys().hasOnly(...)` during updates, blocking any shadow keys).

---

### Thread 2: Chat Room Trespassing
#### Payload 3: Trespassing in a Private Room (Read)
*   **Target Path**: `/chats/private_chat_abc`
*   **Operation**: `get` or `list`
*   **Intention**: Non-participant user tries to read details of a chat room.
*   **Result**: **DENIED** (Enforced by checking `request.auth.uid in resource.data.participantIds`).

#### Payload 4: Arbitrary Chat Injection (Create)
*   **Target Path**: `/chats/attacker_fabricated_chat`
*   **Operation**: `create`
*   **Intention**: User creates a chat room but excludes themselves from the participant list, or spoofs members.
```json
{
  "id": "attacker_fabricated_chat",
  "type": "direct",
  "participantIds": ["victim_1", "victim_2"],
  "createdAt": "request.time",
  "updatedAt": "request.time"
}
```
*   **Result**: **DENIED** (Enforced by validating `request.auth.uid in incoming().participantIds` and exact creation keys/roles).

#### Payload 5: Shadow Group Escalation (Update)
*   **Target Path**: `/chats/shared_chat_xyz`
*   **Operation**: `update`
*   **Intention**: Participant attempts to silently inject an unauthorized third-party user into a direct 2-person chat, converting it into a stealth group.
```json
{
  "id": "shared_chat_xyz",
  "type": "direct",
  "participantIds": ["attacker", "victim", "stealth_attacker_2"],
  "createdAt": "2026-07-18T18:00:00Z",
  "updatedAt": "request.time"
}
```
*   **Result**: **DENIED** (Enforced by blocking updates to `type` and validating size constraints or disabling list updates for non-admins).

---

### Thread 3: Message Spoofing & Poisoning
#### Payload 6: Sending a Message as Someone Else
*   **Target Path**: `/chats/shared_chat_xyz/messages/msg_999`
*   **Operation**: `create`
*   **Intention**: Attacker attempts to forge a message claiming to be from the victim user ID.
```json
{
  "id": "msg_999",
  "senderId": "victim_uid_999",
  "senderName": "Victim Name",
  "senderPhoto": "https://example.com/avatar.png",
  "timestamp": "request.time",
  "isEncrypted": true,
  "ciphertext": "malicious_content",
  "iv": "iv_base64",
  "salt": "salt_base64",
  "previewText": "🔒 Encrypted Message"
}
```
*   **Result**: **DENIED** (Enforced by verifying `incoming().senderId == request.auth.uid`).

#### Payload 7: Trespasser Message Injection (Out of Bounds)
*   **Target Path**: `/chats/victim_private_chat/messages/msg_123`
*   **Operation**: `create`
*   **Intention**: An authenticated user who is NOT a participant in `victim_private_chat` attempts to inject a message.
*   **Result**: **DENIED** (Enforced by Master Gate fetch of the parent chat document, confirming `request.auth.uid in get(/databases/$(database)/documents/chats/$(chatId)).data.participantIds`).

#### Payload 8: Message Tampering (Update / Edit)
*   **Target Path**: `/chats/shared_chat_xyz/messages/msg_123`
*   **Operation**: `update`
*   **Intention**: Attacker tries to alter historical encrypted messages or change the ciphertext of an existing message.
*   **Result**: **DENIED** (Enforced by outright blocking `update` and `delete` operations on `/chats/{chatId}/messages/{messageId}`).

---

### Thread 4: Infrastructure & Storage Exhaustion (Denial of Wallet)
#### Payload 9: ID Poisoning (Junk-Character ID Attack)
*   **Target Path**: `/chats/$$$__BAD_CHARACTER_LONG_STRING_ID_OVER_500_CHARS_MALICIOUS_FOR_EXHAUSTION__$$$`
*   **Operation**: `create`
*   **Intention**: Try to write documents with extremely long keys containing illegal characters, bloating index storage.
*   **Result**: **DENIED** (Enforced by `isValidId(chatId)` verifying length <= 128 and matching regex `^[a-zA-Z0-9_\-]+$`).

#### Payload 10: Payload Bloat Attack (10MB Fake Base64 ciphertext)
*   **Target Path**: `/chats/shared_chat_xyz/messages/msg_huge`
*   **Operation**: `create`
*   **Intention**: Inject an massive, bloated string as ciphertext to inflate the project's Firestore database size.
*   **Result**: **DENIED** (Enforced by `incoming().ciphertext.size() <= 10000` size checks on message creation).

---

### Thread 5: Temporal & Client Manipulation
#### Payload 11: Backdated / Future Messages
*   **Target Path**: `/chats/shared_chat_xyz/messages/msg_backdated`
*   **Operation**: `create`
*   **Intention**: Attacker attempts to forge timestamps to manipulate the conversation order (e.g., setting the date to 2010 or 2035).
```json
{
  "id": "msg_backdated",
  "senderId": "attacker",
  "senderName": "Attacker",
  "senderPhoto": "https://example.com/avatar.png",
  "timestamp": "2010-01-01T00:00:00Z",
  "isEncrypted": true,
  "ciphertext": "abc",
  "iv": "iv",
  "salt": "salt",
  "previewText": "🔒 Encrypted Message"
}
```
*   **Result**: **DENIED** (Enforced by `incoming().timestamp == request.time`).

#### Payload 12: Fake Last Seen / Heartbeat Hijacking
*   **Target Path**: `/users/attacker`
*   **Operation**: `update`
*   **Intention**: Set the offline status of oneself but forge `lastSeen` into the far future to mock system latency checks.
```json
{
  "uid": "attacker",
  "displayName": "Attacker",
  "email": "attacker@example.com",
  "status": "offline",
  "lastSeen": "2045-12-31T23:59:59Z"
}
```
*   **Result**: **DENIED** (Enforced by `incoming().lastSeen == request.time`).
