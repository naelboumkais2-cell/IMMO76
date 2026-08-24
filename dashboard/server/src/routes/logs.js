import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';

export const logsRouter = Router();

logsRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        const logs = await db
            .prepare(
                `SELECT l.*, a.titre AS annonce_titre, p.nom AS portail_nom,
                        u.email AS utilisateur_email, u.nom AS utilisateur_nom
                 FROM logs_api l
                 LEFT JOIN annonces a ON a.id = l.annonce_id
                 LEFT JOIN portails p ON p.id = l.portail_id
                 LEFT JOIN utilisateurs u ON u.id = l.utilisateur_id
                 ORDER BY l.id DESC
                 LIMIT 200`
            )
            .all();
        res.json(logs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Historique des connexions/déconnexions (voir routes/auth.js) — qui s'est connecté et quand,
// distinct des actions métier tracées par logs_api.
logsRouter.get('/connexions', exigerConnexion, async (req, res) => {
    try {
        const connexions = await db
            .prepare(
                `SELECT c.*, u.email AS utilisateur_email, u.nom AS utilisateur_nom
                 FROM connexions_log c
                 LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
                 ORDER BY c.id DESC
                 LIMIT 200`
            )
            .all();
        res.json(connexions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});
