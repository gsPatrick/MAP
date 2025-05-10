// src/features/User/user.routes.js
const { Router } = require('express');
const userController = require('./user.controller');
const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Rotas Públicas (ou semi-públicas, dependendo da sua lógica de primeiro admin)
router.post('/register', userController.createUser); // Rota para criar um novo usuário (admin)
router.post('/login', userController.loginUser);     // Rota de login

// Rotas Protegidas (exigem token JWT válido)
router.use(authenticateToken); // Todas as rotas abaixo desta linha exigem autenticação

router.get('/me', userController.getCurrentUser); // Obter dados do usuário logado

// Rotas restritas a Admins
router.get('/', authorizeRole(['admin']), userController.getAllUsers);
router.get('/:id', authorizeRole(['admin']), userController.getUserById);
router.put('/:id', authorizeRole(['admin']), userController.updateUser); // Admin pode atualizar qualquer user
// Usuário pode atualizar a si mesmo (rota separada ou lógica no controller updateUser)
// router.put('/me/update', userController.updateSelf);
router.delete('/:id', authorizeRole(['admin']), userController.deleteUser);

module.exports = router;