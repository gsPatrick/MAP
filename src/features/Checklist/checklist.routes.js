// src/features/Checklist/checklist.routes.js (Novo Arquivo)
const { Router } = require('express');
const checklistController = require('./checklist.controller');
const { authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true });

// Middleware para garantir que apenas perfis PJ/MEI acessem estas rotas
const authorizeBusinessProfile = (req, res, next) => {
    if (req.financialAccount && ['PJ', 'MEI'].includes(req.financialAccount.accountType)) {
        return next();
    }
    return res.status(403).json({ status: 'fail', message: 'Checklist está disponível apenas para perfis de negócio (PJ/MEI).' });
};

router.use(authorizeBusinessProfile);

// Rotas
router.get('/:date', checklistController.getChecklist);
router.post('/:date/items', checklistController.addItem);

// Para update e delete, usamos a rota sem a data, pois o ID do item é único.
// O middleware de autorização já nos dá o financialAccountId no req.
router.put('/items/:itemId', checklistController.updateItem);
router.delete('/items/:itemId', checklistController.deleteItem);

module.exports = router;