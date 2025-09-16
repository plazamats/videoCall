# Mimi Video Call Backend

This is the Node.js signaling server for the Mimi video calling app. It handles WebRTC signaling, user matching, and real-time communication between users.

## Features

- **Real-time WebRTC signaling** using Socket.IO
- **Smart user matching** based on university, gender, and other preferences
- **Room management** for video calls
- **Connection monitoring** and cleanup
- **Health checks** and statistics endpoints
- **Scalable architecture** ready for production

## Prerequisites

- Node.js (version 14 or higher)
- npm or yarn package manager

## Installation

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

## Running the Server

### Development Mode
```bash
npm run dev
```
This uses nodemon for automatic restarts during development.

### Production Mode
```bash
npm start
```

The server will start on port 8080 by default. You can change this by setting the `PORT` environment variable.

## API Endpoints

### Health Check
- **GET** `/health` - Returns server health status
- **GET** `/stats` - Returns server statistics (connected users, active rooms, etc.)

## Socket.IO Events

### Client to Server Events

- `register-user` - Register a user with the server
  ```javascript
  {
    userId: "user123",
    userInfo: {
      university: "Cape Peninsula University of Technology",
      gender: "Male",
      year: "3rd Year"
    }
  }
  ```

- `find-random-partner` - Start searching for a video call partner

- `accept-call` - Accept an incoming video call

- `reject-call` - Reject an incoming video call

- `offer` - Send WebRTC offer to partner
  ```javascript
  {
    sdp: "...",
    type: "offer"
  }
  ```

- `answer` - Send WebRTC answer to partner
  ```javascript
  {
    sdp: "...",
    type: "answer"
  }
  ```

- `ice-candidate` - Send ICE candidate to partner
  ```javascript
  {
    candidate: { ... }
  }
  ```

- `end-call` - End the current video call

### Server to Client Events

- `registration-success` - User successfully registered
- `partner-found` - A compatible partner was found
- `incoming-call` - Receiving an incoming call
- `searching-for-partner` - Currently searching for a partner
- `partner-search-timeout` - No partner found within timeout
- `call-accepted` - Call was accepted by partner
- `call-rejected` - Call was rejected by partner
- `offer` - Received WebRTC offer from partner
- `answer` - Received WebRTC answer from partner
- `ice-candidate` - Received ICE candidate from partner
- `user-left` - Partner left the call
- `error` - An error occurred

## Configuration

You can modify matching preferences in the `signaling-server.js` file:

```javascript
const matchingPreferences = {
  sameUniversity: false, // Set to true for same university matching
  sameGender: false,     // Set to true for same gender matching
  maxWaitTime: 30000     // 30 seconds max wait time
};
```

## Deployment

### Using PM2 (Recommended for production)

1. Install PM2 globally:
```bash
npm install -g pm2
```

2. Start the server with PM2:
```bash
pm2 start signaling-server.js --name "mimi-signaling"
```

3. Save PM2 configuration:
```bash
pm2 save
pm2 startup
```

### Using Docker

1. Create a Dockerfile:
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["npm", "start"]
```

2. Build and run:
```bash
docker build -t mimi-signaling .
docker run -p 8080:8080 mimi-signaling
```

### Environment Variables

- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment (development/production)

## TURN Server Configuration

For production use, you'll need to configure a TURN server for users behind NAT/firewalls. Update the WebRTC service in your Flutter app:

```dart
final configuration = <String, dynamic>{
  'iceServers': [
    {'urls': 'stun:stun.l.google.com:19302'},
    {
      'urls': 'turn:your-turn-server.com:3478',
      'username': 'your-username',
      'credential': 'your-password'
    }
  ],
};
```

## Monitoring

The server provides real-time statistics at `/stats`:

```json
{
  "connectedUsers": 25,
  "waitingUsers": 3,
  "activeRooms": 11,
  "uptime": 3600
}
```

## Security Considerations

- Implement rate limiting for connection attempts
- Add authentication/authorization for production
- Use HTTPS/WSS in production
- Validate all incoming data
- Implement proper CORS policies

## Troubleshooting

### Common Issues

1. **Port already in use**: Change the port in package.json or set PORT environment variable
2. **Connection refused**: Make sure the server is running and accessible
3. **CORS errors**: Update CORS configuration in the server

### Logs

The server logs important events to the console. In production, consider using a proper logging solution like Winston.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details