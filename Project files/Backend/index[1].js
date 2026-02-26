const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const config = require('./config');
const { User, Complaint, Assigned, Message, Feedback } = require('./Schema');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.set('io', io);

const auth = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
    try {
        const decoded = jwt.verify(token.replace("Bearer ", ""), 'SECRET_KEY');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Invalid token.' });
    }
};

const errorHandler = (err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        error: err.message || 'Server Error',
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

mongoose.connect(config.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

app.get('/', (req, res) => {
    res.send('Welcome to ResolveNow API');
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const complaintStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const complaintUpload = multer({
    storage: complaintStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|pdf|doc|docx/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only images and documents are allowed!'));
    }
});

const messageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const messageUpload = multer({ storage: messageStorage });

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone, userType } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, email, password: hashedPassword, phone, userType });
        await newUser.save();
        const token = jwt.sign({ id: newUser._id, userType: newUser.userType }, 'SECRET_KEY', { expiresIn: '1h' });
        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: { id: newUser._id, name: newUser.name, userType: newUser.userType }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ id: user._id, userType: user.userType }, 'SECRET_KEY', { expiresIn: '1h' });
        res.json({ token, user: { id: user._id, name: user.name, userType: user.userType } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ message: 'Logout successful' });
});

app.get('/api/auth/agents', async (req, res) => {
    try {
        const agents = await User.find({ userType: 'Agent' }).select('-password');
        const agentsWithCounts = await Promise.all(agents.map(async (agent) => {
            const assignments = await Assigned.find({ agentId: agent._id }).populate('complaintId');
            const activeCount = assignments.filter(a => a.complaintId && a.complaintId.status !== 'Resolved').length;
            return { ...agent.toObject(), activeAssignments: activeCount };
        }));
        res.json(agentsWithCounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/complaints', auth, complaintUpload.array('attachments', 10), async (req, res) => {
    try {
        const complaintData = req.body;
        if (req.files && req.files.length > 0) {
            const attachmentNames = req.body.attachmentNames || [];
            const namesList = Array.isArray(attachmentNames) ? attachmentNames : [attachmentNames];
            complaintData.attachments = req.files.map((file, index) => ({
                path: file.path,
                originalName: file.originalname,
                name: namesList[index] || file.originalname
            }));
        } else {
            complaintData.attachments = [];
        }
        const newComplaint = new Complaint(complaintData);
        const savedComplaint = await newComplaint.save();
        const ioInstance = req.app.get('io');
        ioInstance.emit('complaintCreated', savedComplaint);
        res.status(201).json(savedComplaint);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/complaints', auth, async (req, res) => {
    try {
        const complaints = await Complaint.find()
            .populate('userId', 'name email')
            .populate('assignment', 'agentName agentId');
        res.json(complaints);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/complaints/:id', auth, async (req, res) => {
    try {
        const complaint = await Complaint.findById(req.params.id)
            .populate('userId', 'name email')
            .populate('assignment', 'agentName agentId');
        if (!complaint) return res.status(404).json({ error: 'Complaint not found' });
        res.json(complaint);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/complaints/:id', async (req, res) => {
    try {
        const updatedComplaint = await Complaint.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        if (!updatedComplaint) return res.status(404).json({ error: 'Complaint not found' });
        const ioInstance = req.app.get('io');
        ioInstance.emit('complaintUpdated', updatedComplaint);
        res.json(updatedComplaint);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/complaints/:id', auth, async (req, res) => {
    try {
        const deletedComplaint = await Complaint.findByIdAndDelete(req.params.id);
        if (!deletedComplaint) return res.status(404).json({ error: 'Complaint not found' });
        const ioInstance = req.app.get('io');
        ioInstance.emit('complaintDeleted', req.params.id);
        res.json({ message: 'Complaint deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/assigned', auth, async (req, res) => {
    try {
        const { complaintId, agentId, agentName } = req.body;
        const existingAssignment = await Assigned.findOne({ complaintId });
        if (existingAssignment) {
            return res.status(400).json({ error: 'Complaint is already assigned to an agent' });
        }
        const agentAssignments = await Assigned.find({ agentId }).populate('complaintId');
        const activeAgentCount = agentAssignments.filter(a => a.complaintId && a.complaintId.status !== 'Resolved').length;
        if (activeAgentCount >= 3) {
            return res.status(400).json({ error: 'Agent has reached maximum limit of 3 active assignments' });
        }
        const newAssignment = new Assigned({ complaintId, agentId, agentName });
        const savedAssignment = await newAssignment.save();

        await Complaint.findByIdAndUpdate(complaintId, { status: 'Assigned' });

        const updatedComplaint = await Complaint.findById(complaintId);
        const ioInstance = req.app.get('io');
        ioInstance.emit('complaintUpdated', updatedComplaint);

        res.status(201).json(savedAssignment);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ error: 'Complaint is already assigned to an agent' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assigned/agent/:agentId', auth, async (req, res) => {
    try {
        const assignments = await Assigned.find({ agentId: req.params.agentId })
            .populate({
                path: 'complaintId',
                populate: { path: 'userId', select: 'name email' }
            });
        res.json(assignments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assigned', auth, async (req, res) => {
    try {
        const assignments = await Assigned.find().populate('complaintId agentId');
        res.json(assignments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', messageUpload.array('attachments', 5), async (req, res) => {
    try {
        const { complaintId, name, message } = req.body;
        const newMessageData = { complaintId, name, message };
        if (req.files && req.files.length > 0) {
            newMessageData.attachments = req.files.map(file => ({
                path: file.path,
                originalName: file.originalname,
                name: file.originalname
            }));
        }
        const newMessage = new Message(newMessageData);
        const savedMessage = await newMessage.save();
        const ioInstance = req.app.get('io');
        ioInstance.emit('newMessage', savedMessage);
        res.status(201).json(savedMessage);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages/:complaintId', auth, async (req, res) => {
    try {
        const messages = await Message.find({ complaintId: req.params.complaintId }).sort({ sentAt: 1 });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/messages/read/:complaintId', auth, async (req, res) => {
    try {
        const { complaintId } = req.params;
        const userName = req.user.name;
        await Message.updateMany(
            { complaintId, name: { $ne: userName }, read: false },
            { $set: { read: true } }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages/unread/counts', auth, async (req, res) => {
    try {
        const userName = req.user.name;
        const unreadMessages = await Message.aggregate([
            { $match: { name: { $ne: userName }, read: false } },
            { $group: { _id: '$complaintId', count: { $sum: 1 } } }
        ]);
        const counts = {};
        unreadMessages.forEach(item => {
            counts[item._id] = item.count;
        });
        res.json(counts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/feedback', auth, async (req, res) => {
    try {
        const { complaintId, rating, comment } = req.body;
        const userId = req.user.id;
        const assignment = await Assigned.findOne({ complaintId });
        const agentId = assignment ? assignment.agentId : null;
        const newFeedback = new Feedback({
            userId,
            complaintId,
            agentId,
            rating,
            comment
        });
        const savedFeedback = await newFeedback.save();
        res.status(201).json(savedFeedback);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/complaint/:complaintId', auth, async (req, res) => {
    try {
        const feedback = await Feedback.findOne({ complaintId: req.params.complaintId });
        res.json(feedback);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/feedback/agent/:agentId', auth, async (req, res) => {
    try {
        const feedbacks = await Feedback.find({ agentId: req.params.agentId }).populate('userId', 'name');
        res.json(feedbacks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/profile', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/profile', auth, async (req, res) => {
    try {
        const { name, email, phone } = req.body;
        const updateData = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (phone) updateData.phone = phone;
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: updateData },
            { new: true, runValidators: true }
        ).select('-password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users', auth, async (req, res) => {
    try {
        if (req.user.userType !== 'Admin') {
            return res.status(403).json({ error: 'Access denied. Admins only.' });
        }
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', auth, async (req, res) => {
    try {
        if (req.user.userType !== 'Admin') {
            return res.status(403).json({ error: 'Access denied. Admins only.' });
        }
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use(errorHandler);

server.listen(config.PORT, () => {
    console.log(`Server is running on port ${config.PORT}`);
});
