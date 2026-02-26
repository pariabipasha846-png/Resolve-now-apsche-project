const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: { type: String, required: true },
    userType: { type: String, enum: ['Customer', 'Agent', 'Admin'], default: 'Customer' },
    createdAt: { type: Date, default: Date.now }
});

const ComplaintSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    comment: { type: String, required: true },
    attachments: [{
        path: { type: String, required: true },
        name: { type: String },
        originalName: { type: String }
    }],
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

ComplaintSchema.virtual('assignment', {
    ref: 'Assigned',
    localField: '_id',
    foreignField: 'complaintId',
    justOne: true
});

const AssignedSchema = new mongoose.Schema({
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    complaintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true, unique: true },
    agentName: { type: String, required: true },
    status: { type: String, default: 'Assigned' },
    assignedAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
    complaintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true },
    name: { type: String, required: true },
    message: { type: String, required: true },
    attachments: [{
        path: { type: String, required: true },
        name: { type: String },
        originalName: { type: String }
    }],
    read: { type: Boolean, default: false },
    sentAt: { type: Date, default: Date.now }
});

const FeedbackSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    complaintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Complaint = mongoose.model('Complaint', ComplaintSchema);
const Assigned = mongoose.model('Assigned', AssignedSchema);
const Message = mongoose.model('Message', MessageSchema);
const Feedback = mongoose.model('Feedback', FeedbackSchema);

module.exports = { User, Complaint, Assigned, Message, Feedback };

