// ==========================================
// SUPABASE CONFIGURATION
// ==========================================
const SUPABASE_URL = 'https://picvzwhbnthkmukqfdhr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpY3Z6d2hibnRoa211a3FmZGhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MDg1OTgsImV4cCI6MjEwNTk4NDU5OH0.O7w3WOHouRHHOKtzQKGKMhVOllngA7f63uXnTyOb028';

// Initialize Supabase using the globally loaded CDN library
let supabase = null;
try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase connected successfully!');
} catch (err) {
    console.error('❌ Supabase failed to initialize:', err.message);
}

// ==========================================
// APP STATE
// ==========================================
let isAnonymous = false;
let profile = null;
let currentPartner = null;
let currentRoomId = null;
let myUserId = 'user_' + Math.random().toString(36).substr(2, 9);

console.log('My user ID this session:', myUserId);

// ==========================================
// DOM ELEMENTS
// ==========================================
const pages       = document.querySelectorAll('.page');
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendBtn      = document.getElementById('send-btn');
const partnerName  = document.getElementById('partner-name');
const partnerStatus= document.getElementById('partner-status');
const chatList     = document.getElementById('chat-list');

// ==========================================
// NAVIGATION
// ==========================================
function showPage(pageId) {
    console.log('➡️ Navigating to:', pageId);
    pages.forEach(p => p.classList.remove('active'));
    const target = document.getElementById(pageId);
    if (target) {
        target.classList.add('active');
    } else {
        console.error('Page not found:', pageId);
    }

    if (pageId === 'landing-page') {
        // Clean up when leaving
        profile = null;
        currentPartner = null;
        currentRoomId = null;
        isAnonymous = false;
        if (supabase) supabase.removeAllChannels();
        resetChatUI();
    }
}

// ==========================================
// ANONYMOUS MODE
// ==========================================
function startAnonymousMode() {
    console.log('🕶️ Starting anonymous mode');
    isAnonymous = true;
    profile = {
        name: 'Anonymous',
        gender: 'hidden',
        interestedIn: 'everyone',
        isAnonymous: true
    };
    showPage('chat-interface');
}

// ==========================================
// FIND RANDOM PARTNER (Matchmaking)
// ==========================================
async function findRandomPartner() {
    console.log('🔍 Finding random partner...');

    if (!supabase) {
        addSystemMessage('❌ Not connected to server. Check your internet and refresh.');
        return;
    }
    if (!profile) {
        addSystemMessage('❌ Profile not set. Please go back and fill your details.');
        return;
    }

    // Reset UI
    partnerName.textContent = 'Searching...';
    partnerStatus.textContent = 'Looking for someone...';
    messageInput.disabled = true;
    sendBtn.disabled = true;
    chatMessages.innerHTML = '';
    addSystemMessage('🔍 Looking for someone to chat with...');

    // Remove old channels
    supabase.removeAllChannels();
    currentRoomId = null;

    try {
        // 1. Insert self into waiting queue
        const { error: queueError } = await supabase
            .from('waiting_queue')
            .upsert([{
                user_id: myUserId,
                name: profile.name,
                gender: profile.gender,
                interested_in: profile.interestedIn,
                is_anonymous: profile.isAnonymous
            }], { onConflict: 'user_id' });

        if (queueError) {
            console.error('Queue insert error:', queueError);
            throw queueError;
        }

        console.log('✅ Joined waiting queue');

        // 2. Poll for a match (up to 30 seconds, checking every 2s)
        let matchedUser = null;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));

            const { data: queueData, error: fetchError } = await supabase
                .from('waiting_queue')
                .select('*')
                .neq('user_id', myUserId)
                .limit(1);

            if (fetchError) {
                console.error('Queue fetch error:', fetchError);
                continue;
            }

            if (queueData && queueData.length > 0) {
                matchedUser = queueData[0];
                console.log('🎯 Found potential match:', matchedUser.user_id);

                // 3. Create a room
                const { data: roomData, error: roomError } = await supabase
                    .from('rooms')
                    .insert([{ user1_id: myUserId, user2_id: matchedUser.user_id }])
                    .select()
                    .single();

                if (roomError) {
                    // Room creation may fail due to race condition - skip and retry
                    console.warn('Room creation conflict, retrying...', roomError.message);
                    matchedUser = null;
                    continue;
                }

                if (roomData) {
                    currentRoomId = roomData.id;
                    console.log('✅ Room created:', currentRoomId);

                    // 4. Remove both users from queue
                    await supabase.from('waiting_queue').delete().eq('user_id', myUserId);
                    await supabase.from('waiting_queue').delete().eq('user_id', matchedUser.user_id);
                    break;
                }
            }

            // Also check if someone else already created a room with us
            const { data: existingRoom } = await supabase
                .from('rooms')
                .select('*')
                .or(`user1_id.eq.${myUserId},user2_id.eq.${myUserId}`)
                .order('created_at', { ascending: false })
                .limit(1);

            if (existingRoom && existingRoom.length > 0) {
                currentRoomId = existingRoom[0].id;
                const partnerId = existingRoom[0].user1_id === myUserId
                    ? existingRoom[0].user2_id
                    : existingRoom[0].user1_id;

                // Get partner details from queue (may already be removed, use placeholder)
                const { data: partnerData } = await supabase
                    .from('waiting_queue')
                    .select('*')
                    .eq('user_id', partnerId)
                    .single();

                matchedUser = partnerData || { user_id: partnerId, name: 'Anonymous', gender: 'hidden', is_anonymous: true };
                await supabase.from('waiting_queue').delete().eq('user_id', myUserId);
                console.log('✅ Found existing room:', currentRoomId);
                break;
            }

            addSystemMessage(`Still searching... (${i + 1}/15)`);
        }

        if (matchedUser && currentRoomId) {
            setupRoom(matchedUser);
        } else {
            // Timeout - remove from queue
            await supabase.from('waiting_queue').delete().eq('user_id', myUserId);
            chatMessages.innerHTML = '';
            addSystemMessage('😔 No one is online right now. Try again in a minute!');
            partnerName.textContent = 'No match found';
            partnerStatus.textContent = 'Try again';
        }

    } catch (err) {
        console.error('Matchmaking error:', err);
        addSystemMessage('❌ Error: ' + err.message);
    }
}

// ==========================================
// ROOM SETUP & REAL-TIME MESSAGES
// ==========================================
function setupRoom(matchedUser) {
    currentPartner = matchedUser;

    partnerName.textContent = matchedUser.is_anonymous ? 'Anonymous User' : (matchedUser.name || 'Someone');
    partnerStatus.textContent = matchedUser.is_anonymous ? '🕶️ Incognito' : `💬 ${matchedUser.gender || 'Unknown'}`;

    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();

    chatMessages.innerHTML = '';
    addSystemMessage(`🎉 You are now chatting with ${partnerName.textContent}. Say hi!`);

    addToRecentChats(matchedUser);
    subscribeToMessages(currentRoomId);
}

function subscribeToMessages(roomId) {
    console.log('📡 Subscribing to room:', roomId);
    supabase
        .channel('room:' + roomId)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: 'room_id=eq.' + roomId
        }, payload => {
            const msg = payload.new;
            if (msg.sender_id !== myUserId) {
                addMessageToUI(msg.content, 'received');
            }
        })
        .subscribe(status => {
            console.log('Channel status:', status);
        });
}

// ==========================================
// SEND MESSAGE
// ==========================================
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    if (!currentRoomId) {
        addSystemMessage('❌ Not in a chat room. Click Random Chat first!');
        return;
    }

    addMessageToUI(text, 'sent');
    messageInput.value = '';

    const { error } = await supabase
        .from('messages')
        .insert([{ room_id: currentRoomId, sender_id: myUserId, content: text }]);

    if (error) {
        console.error('Send error:', error);
        addSystemMessage('❌ Failed to send message: ' + error.message);
    }
}

// ==========================================
// UI HELPERS
// ==========================================
function addMessageToUI(text, type) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.classList.add('system-message');
    div.innerHTML = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addToRecentChats(user) {
    if (!chatList) return;
    const existing = Array.from(chatList.children).find(li => li.dataset.id === user.user_id);
    if (existing) return;

    const li = document.createElement('li');
    li.classList.add('chat-item');
    li.dataset.id = user.user_id;
    const displayName = user.is_anonymous ? 'Anonymous' : (user.name || 'Unknown');
    li.innerHTML = `
        <div class="avatar"><i class="fa-solid fa-user"></i></div>
        <div>
            <h5 style="color:white">${displayName}</h5>
            <small style="color:var(--text-muted)">Recent match</small>
        </div>
    `;
    chatList.prepend(li);
}

function resetChatUI() {
    if (partnerName) partnerName.textContent = 'Waiting for connection...';
    if (partnerStatus) partnerStatus.textContent = 'Click Random Chat to start';
    if (messageInput) messageInput.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    if (chatMessages) chatMessages.innerHTML = '<div class="system-message">Click <strong>Random Chat</strong> to connect with someone!</div>';
    if (chatList) chatList.innerHTML = '';
}

// ==========================================
// ATTACH ALL EVENT LISTENERS ON PAGE LOAD
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM loaded. Attaching event listeners...');

    // Landing page
    const btnJoinProfile = document.getElementById('btn-join-profile');
    if (btnJoinProfile) {
        btnJoinProfile.addEventListener('click', () => {
            console.log('Join with Profile clicked');
            showPage('profile-setup');
        });
    }

    const btnJoinAnonymous = document.getElementById('btn-join-anonymous');
    if (btnJoinAnonymous) {
        btnJoinAnonymous.addEventListener('click', () => {
            console.log('Join Anonymous clicked');
            showPage('anonymous-chat');
        });
    }

    // Profile setup
    const btnBackProfile = document.getElementById('btn-back-profile');
    if (btnBackProfile) btnBackProfile.addEventListener('click', () => showPage('landing-page'));

    const profileForm = document.getElementById('profile-form');
    if (profileForm) {
        profileForm.addEventListener('submit', (e) => {
            e.preventDefault();
            console.log('Profile form submitted');
            const nameVal = document.getElementById('name').value.trim();
            const genderVal = document.getElementById('gender').value;
            const interestVal = document.getElementById('interested-in').value;

            if (!nameVal || !genderVal || !interestVal) {
                alert('Please fill in all required fields!');
                return;
            }

            profile = {
                name: nameVal,
                gender: genderVal,
                interestedIn: interestVal,
                bio: document.getElementById('bio').value,
                isAnonymous: false
            };
            isAnonymous = false;
            showPage('chat-interface');
        });
    }

    // Anonymous page
    const btnBackAnonymous = document.getElementById('btn-back-anonymous');
    if (btnBackAnonymous) btnBackAnonymous.addEventListener('click', () => showPage('landing-page'));

    const btnEnterAnonymous = document.getElementById('btn-enter-anonymous');
    if (btnEnterAnonymous) {
        btnEnterAnonymous.addEventListener('click', () => {
            console.log('Enter Anonymous clicked');
            startAnonymousMode();
        });
    }

    // Chat interface
    const btnRandomChat = document.getElementById('btn-random-chat');
    if (btnRandomChat) btnRandomChat.addEventListener('click', findRandomPartner);

    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) btnSkip.addEventListener('click', findRandomPartner);

    const btnLeave = document.getElementById('btn-leave');
    if (btnLeave) btnLeave.addEventListener('click', () => showPage('landing-page'));

    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            sendMessage();
        });
    }

    console.log('✅ All event listeners attached successfully!');
});
