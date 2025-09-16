const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// Store connected users and their preferences
const connectedUsers = new Map();
const waitingUsers = new Set();
const activeRooms = new Map();
const userProfiles = new Map(); // Store user profiles for discovery
const followRelationships = new Map(); // Store follow relationships
const userStatuses = new Map(); // Store user status updates
const chatMessages = new Map(); // Store chat messages by conversation ID

// User matching preferences
const matchingPreferences = {
  sameUniversity: false, // Set to true if you want same university matching
  sameGender: false,     // Set to true if you want same gender matching
  maxWaitTime: 30000     // 30 seconds max wait time
};

class User {
  constructor(socketId, userId, userInfo = {}) {
    this.socketId = socketId;
    this.userId = userId;
    this.university = userInfo.university || '';
    this.gender = userInfo.gender || '';
    this.year = userInfo.year || '';
    this.joinedAt = Date.now();
    this.isWaiting = false;
    this.currentRoom = null;
    this.partnerId = null;
  }
}

class Room {
  constructor(roomId, user1, user2) {
    this.roomId = roomId;
    this.users = [user1, user2];
    this.createdAt = Date.now();
    this.isActive = true;
  }

  getOtherUser(userId) {
    return this.users.find(user => user.userId !== userId);
  }
}

// Generate unique room ID
function generateRoomId() {
  return 'room_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// Check if two users are compatible for matching
function areUsersCompatible(user1, user2) {
  // Don't match user with themselves
  if (user1.userId === user2.userId) return false;

  // Check university matching preference
  if (matchingPreferences.sameUniversity && user1.university !== user2.university) {
    return false;
  }

  // Check gender matching preference
  if (matchingPreferences.sameGender && user1.gender !== user2.gender) {
    return false;
  }

  return true;
}

// Find a compatible partner for a user
function findPartner(user) {
  for (const waitingUser of waitingUsers) {
    const potentialPartner = connectedUsers.get(waitingUser);
    if (potentialPartner && areUsersCompatible(user, potentialPartner)) {
      return potentialPartner;
    }
  }
  return null;
}

// Clean up inactive users
function cleanupInactiveUsers() {
  const now = Date.now();
  const maxInactiveTime = 5 * 60 * 1000; // 5 minutes

  for (const [socketId, user] of connectedUsers.entries()) {
    if (now - user.joinedAt > maxInactiveTime && !user.currentRoom) {
      console.log(`Cleaning up inactive user: ${user.userId}`);
      connectedUsers.delete(socketId);
      waitingUsers.delete(socketId);
    }
  }
}

// Clean up empty rooms
function cleanupEmptyRooms() {
  for (const [roomId, room] of activeRooms.entries()) {
    const activeUsers = room.users.filter(user => connectedUsers.has(user.socketId));
    if (activeUsers.length === 0) {
      console.log(`Cleaning up empty room: ${roomId}`);
      activeRooms.delete(roomId);
    }
  }
}

// Run cleanup every 2 minutes
setInterval(() => {
  cleanupInactiveUsers();
  cleanupEmptyRooms();
}, 2 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('register-user', (data) => {
    const { userId, userInfo } = data;
    const user = new User(socket.id, userId, userInfo);
    connectedUsers.set(socket.id, user);
    
    console.log(`User registered: ${userId} from ${userInfo.university || 'Unknown University'}`);
    socket.emit('registration-success', { userId });
  });

  socket.on('find-random-partner', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'User not registered' });
      return;
    }

    if (user.isWaiting) {
      socket.emit('error', { message: 'Already searching for partner' });
      return;
    }

    console.log(`User ${user.userId} is looking for a partner`);
    
    // Try to find an existing partner
    const partner = findPartner(user);
    
    if (partner) {
      // Remove both users from waiting list
      waitingUsers.delete(user.socketId);
      waitingUsers.delete(partner.socketId);
      
      // Create room
      const roomId = generateRoomId();
      const room = new Room(roomId, user, partner);
      activeRooms.set(roomId, room);
      
      // Update user states
      user.currentRoom = roomId;
      user.partnerId = partner.userId;
      user.isWaiting = false;
      
      partner.currentRoom = roomId;
      partner.partnerId = user.userId;
      partner.isWaiting = false;
      
      // Join socket rooms
      socket.join(roomId);
      io.sockets.sockets.get(partner.socketId)?.join(roomId);
      
      console.log(`Match found! Room: ${roomId}, Users: ${user.userId} & ${partner.userId}`);
      
      // Notify both users
      socket.emit('partner-found', {
        roomId,
        partnerId: partner.userId,
        partnerInfo: {
          university: partner.university,
          year: partner.year
        }
      });
      
      io.to(partner.socketId).emit('incoming-call', {
        roomId,
        callerId: user.userId,
        callerInfo: {
          university: user.university,
          year: user.year
        }
      });
      
    } else {
      // Add to waiting list
      user.isWaiting = true;
      waitingUsers.add(socket.id);
      socket.emit('searching-for-partner');
      
      console.log(`User ${user.userId} added to waiting list. Total waiting: ${waitingUsers.size}`);
      
      // Set timeout for waiting
      setTimeout(() => {
        if (user.isWaiting && waitingUsers.has(socket.id)) {
          waitingUsers.delete(socket.id);
          user.isWaiting = false;
          socket.emit('partner-search-timeout');
          console.log(`Search timeout for user: ${user.userId}`);
        }
      }, matchingPreferences.maxWaitTime);
    }
  });

  socket.on('accept-call', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) {
      socket.emit('error', { message: 'No active call to accept' });
      return;
    }

    const room = activeRooms.get(user.currentRoom);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      console.log(`Call accepted in room: ${room.roomId}`);
      io.to(room.roomId).emit('call-accepted', {
        roomId: room.roomId,
        acceptedBy: user.userId
      });
    }
  });

  socket.on('reject-call', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;

    const room = activeRooms.get(user.currentRoom);
    if (!room) return;

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      console.log(`Call rejected in room: ${room.roomId}`);
      io.to(partner.socketId).emit('call-rejected', {
        rejectedBy: user.userId
      });
      
      // Clean up room
      activeRooms.delete(room.roomId);
      user.currentRoom = null;
      user.partnerId = null;
      
      const partnerUser = connectedUsers.get(partner.socketId);
      if (partnerUser) {
        partnerUser.currentRoom = null;
        partnerUser.partnerId = null;
      }
    }
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;

    const room = activeRooms.get(user.currentRoom);
    if (!room) return;

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      console.log(`Forwarding offer in room: ${room.roomId}`);
      io.to(partner.socketId).emit('offer', {
        sdp: data.sdp,
        type: data.type,
        from: user.userId
      });
    }
  });

  socket.on('answer', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;

    const room = activeRooms.get(user.currentRoom);
    if (!room) return;

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      console.log(`Forwarding answer in room: ${room.roomId}`);
      io.to(partner.socketId).emit('answer', {
        sdp: data.sdp,
        type: data.type,
        from: user.userId
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;

    const room = activeRooms.get(user.currentRoom);
    if (!room) return;

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      io.to(partner.socketId).emit('ice-candidate', {
        candidate: data.candidate,
        from: user.userId
      });
    }
  });

  socket.on('end-call', () => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;

    const room = activeRooms.get(user.currentRoom);
    if (!room) return;

    const partner = room.getOtherUser(user.userId);
    if (partner) {
      console.log(`Call ended in room: ${room.roomId}`);
      io.to(partner.socketId).emit('user-left', {
        userId: user.userId
      });
    }

    // Clean up room
    activeRooms.delete(room.roomId);
    user.currentRoom = null;
    user.partnerId = null;
    
    const partnerUser = connectedUsers.get(partner?.socketId);
    if (partnerUser) {
      partnerUser.currentRoom = null;
      partnerUser.partnerId = null;
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    const user = connectedUsers.get(socket.id);
    if (user) {
      // Remove from waiting list
      waitingUsers.delete(socket.id);
      
      // Handle active call
      if (user.currentRoom) {
        const room = activeRooms.get(user.currentRoom);
        if (room) {
          const partner = room.getOtherUser(user.userId);
          if (partner) {
            io.to(partner.socketId).emit('user-left', {
              userId: user.userId
            });
            
            // Clean up partner
            const partnerUser = connectedUsers.get(partner.socketId);
            if (partnerUser) {
              partnerUser.currentRoom = null;
              partnerUser.partnerId = null;
            }
          }
          
          // Clean up room
          activeRooms.delete(room.roomId);
        }
      }
      
      // Remove user
      connectedUsers.delete(socket.id);
      console.log(`Cleaned up user: ${user.userId}`);
    }
  });

  // Health check
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Helper functions for Discover API
function generateUserProfile(userId, userInfo) {
  const universities = [
    'Cape Peninsula University of Technology',
    'University of Cape Town',
    'University of the Witwatersrand',
    'University of Pretoria',
    'University of KwaZulu-Natal',
    'University of Johannesburg',
    'Nelson Mandela University',
    'University of Limpopo',
    'University of Fort Hare',
    'Central University of Technology',
    'Durban University of Technology',
    'Mangosuthu University of Technology',
    'Tshwane University of Technology',
    'Vaal University of Technology',
    'Walter Sisulu University',
    'University of Venda'
  ];

  const courses = [
    'Computer Science', 'Engineering', 'Medicine', 'Business', 'Law',
    'Psychology', 'Education', 'Arts', 'Science', 'Economics',
    'Architecture', 'Nursing', 'Pharmacy', 'Dentistry', 'Journalism'
  ];

  const names = [
    'Thabo Mthembu', 'Nomsa Dlamini', 'Sipho Ndlovu', 'Zanele Khumalo',
    'Mandla Nkomo', 'Precious Mokoena', 'Tshepo Molefe', 'Lerato Mahlangu',
    'Bongani Sithole', 'Nomthandazo Zulu', 'Kagiso Mabena', 'Thandiwe Cele',
    'Sello Motaung', 'Palesa Mokone', 'Mpho Radebe', 'Ntombi Shabalala',
    'Jabu Mthethwa', 'Refilwe Maseko', 'Sizani Ngcobo', 'Tebogo Lekota'
  ];

  return {
    userId,
    name: userInfo.name || names[Math.floor(Math.random() * names.length)],
    university: userInfo.university || universities[Math.floor(Math.random() * universities.length)],
    year: userInfo.year || ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Postgrad'][Math.floor(Math.random() * 5)],
    course: userInfo.course || courses[Math.floor(Math.random() * courses.length)],
    gender: userInfo.gender || ['Male', 'Female'][Math.floor(Math.random() * 2)],
    age: userInfo.age || (18 + Math.floor(Math.random() * 8)),
    bio: userInfo.bio || 'Student passionate about learning and making connections.',
    interests: userInfo.interests || ['Music', 'Sports', 'Reading', 'Technology'].slice(0, 2 + Math.floor(Math.random() * 3)),
    profileImage: `https://picsum.photos/400/400?random=${userId}`,
    isOnline: connectedUsers.has(userId),
    lastSeen: new Date().toISOString(),
    followerCount: Math.floor(Math.random() * 500),
    followingCount: Math.floor(Math.random() * 300),
    postCount: Math.floor(Math.random() * 50)
  };
}

// Discover API endpoints
app.get('/api/discover/users', (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      university, 
      year, 
      gender, 
      course,
      search,
      currentUserId 
    } = req.query;

    // Generate sample users if we don't have enough real users
    const sampleUsers = [];
    const realUsers = Array.from(connectedUsers.values());
    
    // Add real connected users
    realUsers.forEach(user => {
      if (user.userId !== currentUserId) {
        const profile = generateUserProfile(user.userId, {
          university: user.university,
          year: user.year,
          gender: user.gender,
          name: user.name
        });
        sampleUsers.push(profile);
      }
    });

    // Generate additional sample users to fill the list
    const additionalUsersNeeded = Math.max(0, 20 - sampleUsers.length);
    for (let i = 0; i < additionalUsersNeeded; i++) {
      const userId = `sample_user_${Date.now()}_${i}`;
      sampleUsers.push(generateUserProfile(userId, {}));
    }

    // Apply filters
    let filteredUsers = sampleUsers;

    if (university) {
      filteredUsers = filteredUsers.filter(user => 
        user.university.toLowerCase().includes(university.toLowerCase())
      );
    }

    if (year) {
      filteredUsers = filteredUsers.filter(user => user.year === year);
    }

    if (gender) {
      filteredUsers = filteredUsers.filter(user => user.gender === gender);
    }

    if (course) {
      filteredUsers = filteredUsers.filter(user => 
        user.course.toLowerCase().includes(course.toLowerCase())
      );
    }

    if (search) {
      filteredUsers = filteredUsers.filter(user => 
        user.name.toLowerCase().includes(search.toLowerCase()) ||
        user.university.toLowerCase().includes(search.toLowerCase()) ||
        user.course.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedUsers = filteredUsers.slice(startIndex, endIndex);

    // Add follow status for current user
    paginatedUsers.forEach(user => {
      const followKey = `${currentUserId}_${user.userId}`;
      user.isFollowing = followRelationships.has(followKey);
    });

    res.json({
      users: paginatedUsers,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(filteredUsers.length / limit),
        totalUsers: filteredUsers.length,
        hasNext: endIndex < filteredUsers.length,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching discover users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/discover/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { currentUserId } = req.query;

    // Check if it's a real user first
    let userInfo = {};
    for (const user of connectedUsers.values()) {
      if (user.userId === userId) {
        userInfo = {
          university: user.university,
          year: user.year,
          gender: user.gender,
          name: user.name
        };
        break;
      }
    }

    const profile = generateUserProfile(userId, userInfo);
    
    // Add follow status
    const followKey = `${currentUserId}_${userId}`;
    profile.isFollowing = followRelationships.has(followKey);
    
    // Add mutual connections (mock data)
    profile.mutualConnections = Math.floor(Math.random() * 10);
    
    res.json(profile);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.post('/api/discover/follow', (req, res) => {
  try {
    const { currentUserId, targetUserId } = req.body;
    
    if (!currentUserId || !targetUserId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const followKey = `${currentUserId}_${targetUserId}`;
    
    if (followRelationships.has(followKey)) {
      return res.status(400).json({ error: 'Already following this user' });
    }

    followRelationships.set(followKey, {
      followerId: currentUserId,
      followingId: targetUserId,
      createdAt: new Date().toISOString()
    });

    console.log(`User ${currentUserId} followed ${targetUserId}`);
    
    res.json({ 
      success: true, 
      message: 'Successfully followed user',
      isFollowing: true
    });
  } catch (error) {
    console.error('Error following user:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

app.post('/api/discover/unfollow', (req, res) => {
  try {
    const { currentUserId, targetUserId } = req.body;
    
    if (!currentUserId || !targetUserId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const followKey = `${currentUserId}_${targetUserId}`;
    
    if (!followRelationships.has(followKey)) {
      return res.status(400).json({ error: 'Not following this user' });
    }

    followRelationships.delete(followKey);

    console.log(`User ${currentUserId} unfollowed ${targetUserId}`);
    
    res.json({ 
      success: true, 
      message: 'Successfully unfollowed user',
      isFollowing: false
    });
  } catch (error) {
    console.error('Error unfollowing user:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

app.get('/api/discover/suggestions/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;

    // Get current user info for better suggestions
    let currentUser = null;
    for (const user of connectedUsers.values()) {
      if (user.userId === userId) {
        currentUser = user;
        break;
      }
    }

    // Generate suggestions based on similar interests/university
    const suggestions = [];
    const realUsers = Array.from(connectedUsers.values());
    
    // Prioritize users from same university
    realUsers.forEach(user => {
      if (user.userId !== userId && currentUser && user.university === currentUser.university) {
        const profile = generateUserProfile(user.userId, {
          university: user.university,
          year: user.year,
          gender: user.gender,
          name: user.name
        });
        suggestions.push(profile);
      }
    });

    // Fill with random suggestions if needed
    const additionalNeeded = Math.max(0, parseInt(limit) - suggestions.length);
    for (let i = 0; i < additionalNeeded; i++) {
      const suggestionId = `suggestion_${Date.now()}_${i}`;
      suggestions.push(generateUserProfile(suggestionId, {}));
    }

    // Add follow status
    suggestions.forEach(user => {
      const followKey = `${userId}_${user.userId}`;
      user.isFollowing = followRelationships.has(followKey);
    });

    res.json({
      suggestions: suggestions.slice(0, parseInt(limit)),
      total: suggestions.length
    });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Status and Chat API endpoints
app.post('/api/status/create', (req, res) => {
  try {
    const { userId, content, type = 'text', mediaUrl, backgroundColor = '#667eea' } = req.body;
    
    if (!userId || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const statusId = `status_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const status = {
      statusId,
      userId,
      content,
      type, // 'text', 'image', 'video'
      mediaUrl,
      backgroundColor,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      views: [],
      isActive: true
    };

    // Store status for user
    if (!userStatuses.has(userId)) {
      userStatuses.set(userId, []);
    }
    userStatuses.get(userId).push(status);

    console.log(`Status created by ${userId}: ${statusId}`);
    
    res.json({ 
      success: true, 
      status,
      message: 'Status created successfully'
    });
  } catch (error) {
    console.error('Error creating status:', error);
    res.status(500).json({ error: 'Failed to create status' });
  }
});

app.get('/api/status/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { viewerId } = req.query;

    const userStatusList = userStatuses.get(userId) || [];
    const now = new Date();
    
    // Filter active statuses (not expired)
    const activeStatuses = userStatusList.filter(status => {
      const expiresAt = new Date(status.expiresAt);
      return status.isActive && expiresAt > now;
    });

    // Add viewer info and user profile
    const statusesWithProfile = activeStatuses.map(status => ({
      ...status,
      hasViewed: status.views.includes(viewerId),
      viewCount: status.views.length,
      userProfile: generateUserProfile(userId, {})
    }));

    res.json({
      statuses: statusesWithProfile,
      total: statusesWithProfile.length
    });
  } catch (error) {
    console.error('Error fetching user statuses:', error);
    res.status(500).json({ error: 'Failed to fetch statuses' });
  }
});

app.get('/api/status/following/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    // Get users that current user follows
    const followingUsers = [];
    for (const [key, relationship] of followRelationships.entries()) {
      if (relationship.followerId === userId) {
        followingUsers.push(relationship.followingId);
      }
    }

    // Add current user to see their own statuses
    followingUsers.push(userId);

    // Get all statuses from followed users
    const allStatuses = [];
    const now = new Date();

    followingUsers.forEach(followedUserId => {
      const userStatusList = userStatuses.get(followedUserId) || [];
      const activeStatuses = userStatusList.filter(status => {
        const expiresAt = new Date(status.expiresAt);
        return status.isActive && expiresAt > now;
      });

      activeStatuses.forEach(status => {
        allStatuses.push({
          ...status,
          hasViewed: status.views.includes(userId),
          viewCount: status.views.length,
          userProfile: generateUserProfile(followedUserId, {})
        });
      });
    });

    // Sort by creation time (newest first)
    allStatuses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Group by user for better UI
    const groupedStatuses = {};
    allStatuses.forEach(status => {
      if (!groupedStatuses[status.userId]) {
        groupedStatuses[status.userId] = {
          userProfile: status.userProfile,
          statuses: [],
          hasUnviewed: false
        };
      }
      groupedStatuses[status.userId].statuses.push(status);
      if (!status.hasViewed) {
        groupedStatuses[status.userId].hasUnviewed = true;
      }
    });

    res.json({
      groupedStatuses,
      totalUsers: Object.keys(groupedStatuses).length,
      totalStatuses: allStatuses.length
    });
  } catch (error) {
    console.error('Error fetching following statuses:', error);
    res.status(500).json({ error: 'Failed to fetch statuses' });
  }
});

app.post('/api/status/view', (req, res) => {
  try {
    const { statusId, viewerId } = req.body;
    
    if (!statusId || !viewerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Find and update status
    let statusFound = false;
    for (const [userId, statusList] of userStatuses.entries()) {
      const status = statusList.find(s => s.statusId === statusId);
      if (status && !status.views.includes(viewerId)) {
        status.views.push(viewerId);
        statusFound = true;
        console.log(`Status ${statusId} viewed by ${viewerId}`);
        break;
      }
    }

    if (!statusFound) {
      return res.status(404).json({ error: 'Status not found' });
    }

    res.json({ 
      success: true, 
      message: 'Status view recorded'
    });
  } catch (error) {
    console.error('Error recording status view:', error);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

app.delete('/api/status/:statusId', (req, res) => {
  try {
    const { statusId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const userStatusList = userStatuses.get(userId) || [];
    const statusIndex = userStatusList.findIndex(s => s.statusId === statusId);

    if (statusIndex === -1) {
      return res.status(404).json({ error: 'Status not found' });
    }

    // Mark as inactive instead of deleting
    userStatusList[statusIndex].isActive = false;

    console.log(`Status ${statusId} deleted by ${userId}`);
    
    res.json({ 
      success: true, 
      message: 'Status deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting status:', error);
    res.status(500).json({ error: 'Failed to delete status' });
  }
});

// Chat API endpoints
app.get('/api/chat/conversations/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    // Generate sample conversations for demo
    const conversations = [
      {
        conversationId: 'conv_1',
        participants: [userId, 'user_sarah'],
        lastMessage: {
          messageId: 'msg_1',
          senderId: 'user_sarah',
          content: 'Hey! How was your exam?',
          type: 'text',
          timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          isRead: false
        },
        unreadCount: 3,
        otherUser: {
          userId: 'user_sarah',
          name: 'Sarah (UCT)',
          profileImage: 'https://picsum.photos/200?random=1',
          isOnline: true,
          lastSeen: new Date().toISOString()
        }
      },
      {
        conversationId: 'conv_2',
        participants: [userId, 'user_mike'],
        lastMessage: {
          messageId: 'msg_2',
          senderId: userId,
          content: 'Study group tomorrow?',
          type: 'text',
          timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          isRead: true
        },
        unreadCount: 0,
        otherUser: {
          userId: 'user_mike',
          name: 'Mike (Wits)',
          profileImage: 'https://picsum.photos/200?random=2',
          isOnline: false,
          lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString()
        }
      },
      {
        conversationId: 'conv_3',
        participants: [userId, 'user_raza'],
        lastMessage: {
          messageId: 'msg_3',
          senderId: 'user_raza',
          content: 'Thanks for the notes!',
          type: 'text',
          timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          isRead: false
        },
        unreadCount: 1,
        otherUser: {
          userId: 'user_raza',
          name: 'raZa (CPUT)',
          profileImage: 'https://picsum.photos/200?random=3',
          isOnline: true,
          lastSeen: new Date().toISOString()
        }
      }
    ];

    res.json({
      conversations,
      total: conversations.length
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/api/chat/messages/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Generate sample messages for demo
    const messages = [
      {
        messageId: 'msg_1',
        conversationId,
        senderId: 'user_sarah',
        content: 'Hey! How are you?',
        type: 'text',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        isRead: true,
        reactions: []
      },
      {
        messageId: 'msg_2',
        conversationId,
        senderId: 'current_user',
        content: "I'm good! Just finished my lecture",
        type: 'text',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 60000).toISOString(),
        isRead: true,
        reactions: []
      },
      {
        messageId: 'msg_3',
        conversationId,
        senderId: 'user_sarah',
        content: 'Cool! What subject?',
        type: 'text',
        timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        isRead: true,
        reactions: []
      },
      {
        messageId: 'msg_4',
        conversationId,
        senderId: 'current_user',
        content: '',
        type: 'voice',
        duration: 15,
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        isRead: true,
        reactions: []
      },
      {
        messageId: 'msg_5',
        conversationId,
        senderId: 'user_sarah',
        content: 'That sounds interesting!',
        type: 'text',
        timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        isRead: false,
        reactions: []
      }
    ];

    res.json({
      messages,
      pagination: {
        currentPage: parseInt(page),
        totalPages: 1,
        totalMessages: messages.length,
        hasNext: false,
        hasPrev: false
      }
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/chat/send', (req, res) => {
  try {
    const { conversationId, senderId, content, type = 'text', duration } = req.body;
    
    if (!conversationId || !senderId || (!content && type !== 'voice')) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const message = {
      messageId,
      conversationId,
      senderId,
      content,
      type,
      duration: type === 'voice' ? duration : undefined,
      timestamp: new Date().toISOString(),
      isRead: false,
      reactions: []
    };

    // Store message
    if (!chatMessages.has(conversationId)) {
      chatMessages.set(conversationId, []);
    }
    chatMessages.get(conversationId).push(message);

    console.log(`Message sent in ${conversationId} by ${senderId}`);
    
    res.json({ 
      success: true, 
      message,
      messageId
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// API endpoints for monitoring
app.get('/stats', (req, res) => {
  res.json({
    connectedUsers: connectedUsers.size,
    waitingUsers: waitingUsers.size,
    activeRooms: activeRooms.size,
    totalFollowRelationships: followRelationships.size,
    totalStatuses: Array.from(userStatuses.values()).reduce((sum, statuses) => sum + statuses.length, 0),
    totalConversations: chatMessages.size,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`📊 Stats available at http://localhost:${PORT}/stats`);
  console.log(`❤️  Health check at http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});