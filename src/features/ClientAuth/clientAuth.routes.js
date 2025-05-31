// src/features/ClientAuth/clientAuth.routes.js
const { Router } = require('express');
const clientAuthController = require('./clientAuth.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

const router = Router();

router.post('/client/set-credentials', clientAuthController.setCredentials);
router.post('/client/login', clientAuthController.login);
router.get('/client/me', authenticateClientToken, clientAuthController.getCurrentClientProfile);
router.put('/client/me/calendar-preferences', authenticateClientToken, clientAuthController.updateCalendarPreferences);


module.exports = router;