import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { getEspaceActif } from '../integrations/tokenState.js';

export const portailsRouter = Router();

portailsRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        const { espaceLogin } = getEspaceActif();
        const rows = await db.prepare(`SELECT * FROM portails ORDER BY nom`).all();
        res.json(
            rows.map((p) => ({
                ...p,
                est_espace_actif: p.login != null && p.login === espaceLogin ? 1 : 0,
            }))
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

portailsRouter.post('/', exigerConnexion, async (req, res) => {
    const { nom, login = null, mode_publication_defaut = 'brouillon' } = req.body;
    if (!nom || !nom.trim()) return res.status(400).json({ erreur: 'nom requis' });
    try {
        const info = await db
            .prepare(`INSERT INTO portails (nom, login, actif, mode_publication_defaut) VALUES (?, ?, 1, ?) RETURNING id`)
            .run(nom.trim(), login ? login.trim() : null, mode_publication_defaut);
        res.status(201).json(await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
        res.status(409).json({ erreur: 'Un portail avec ce nom ou ce login existe déjà' });
    }
});

portailsRouter.put('/:id', exigerConnexion, async (req, res) => {
    try {
        const { actif, mode_publication_defaut, nom, login } = req.body;
        const existing = await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(req.params.id);
        if (!existing) return res.status(404).json({ erreur: 'Portail introuvable' });

        await db.prepare(
            `UPDATE portails SET
               nom = COALESCE(?, nom),
               login = COALESCE(?, login),
               actif = COALESCE(?, actif),
               mode_publication_defaut = COALESCE(?, mode_publication_defaut)
             WHERE id = ?`
        ).run(
            nom ?? null,
            login ?? null,
            actif === undefined ? null : (actif ? 1 : 0),
            mode_publication_defaut ?? null,
            req.params.id
        );

        res.json(await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

portailsRouter.delete('/:id', exigerConnexion, async (req, res) => {
    try {
        await db.prepare(`DELETE FROM portails WHERE id = ?`).run(req.params.id);
        res.status(204).end();
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// --- Règles de routage par défaut (type de bien -> portails) ---

portailsRouter.get('/regles-routage', exigerConnexion, async (req, res) => {
    try {
        res.json(
            await db
                .prepare(
                    `SELECT r.*, p.nom AS portail_nom
                     FROM regles_routage r JOIN portails p ON p.id = r.portail_id
                     ORDER BY r.id`
                )
                .all()
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

portailsRouter.post('/regles-routage', exigerConnexion, async (req, res) => {
    try {
        const { type_bien = null, portail_id } = req.body;
        if (!portail_id) return res.status(400).json({ erreur: 'portail_id requis' });
        const info = await db
            .prepare(`INSERT INTO regles_routage (type_bien, portail_id, actif) VALUES (?, ?, 1) RETURNING id`)
            .run(type_bien, portail_id);
        res.status(201).json(await db.prepare(`SELECT * FROM regles_routage WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

portailsRouter.delete('/regles-routage/:id', exigerConnexion, async (req, res) => {
    try {
        await db.prepare(`DELETE FROM regles_routage WHERE id = ?`).run(req.params.id);
        res.status(204).end();
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
