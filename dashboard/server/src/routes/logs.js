import { Router } from 'express';
import { db } from '../db.js';

export const logsRouter = Router();

logsRouter.get('/', (req, res) => {
    const logs = db
        .prepare(
            `SELECT l.*, a.titre AS annonce_titre, p.nom AS portail_nom
             FROM logs_api l
             LEFT JOIN annonces a ON a.id = l.annonce_id
             LEFT JOIN portails p ON p.id = l.portail_id
             ORDER BY l.id DESC
             LIMIT 200`
        )
        .all();
    res.json(logs);
});
