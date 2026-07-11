const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
require('dotenv').config();
const { startCleanupScheduler } = require('./src/services/cleanupService');

const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    startCleanupScheduler();
  })
  .catch(err => console.log('DB Error:', err));

// Routes
app.use('/api/listings', require('./src/routes/listings'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/payments', require('./src/routes/payments'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));