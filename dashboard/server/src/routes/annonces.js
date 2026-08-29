import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';

export const annoncesRouter = Router();

// Colonnes explicites, sans `images`/`raw_data`/`donnees_ia` — Supervision (le seul appelant,
// voir Supervision.jsx) n'affiche qu'un tableau de statuts, jamais les photos. `images` seule
// peut peser plusieurs Mo par annonce (jusqu'à 20 photos en base64) : avec LIMIT 200 et un
// rafraîchissement automatique toutes les 5s pendant que l'onglet est ouvert, un `SELECT *` ici
// pouvait retransmettre plusieurs centaines de Mo par minute — identifié comme responsable
// d'un dépassement réel du quota de transfert Neon.
const COLONNES_LISTE_ANNONCES = 'id, external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, scrapee_le, est_annonce_test';

// Diagnostic temporaire (à retirer après livraison de la liste à l'utilisateur) — repère,
// SANS RIEN MODIFIER, les annonces déjà publiées dont le routage ne correspondrait pas à la
// nouvelle règle LMNP/Neuf (lecture seule sur annonces + annonce_portails + portails).
annoncesRouter.get('/diag-routage-lmnp', exigerConnexion, async (req, res) => {
    try {
        const rows = await db
            .prepare(
                `SELECT a.id, a.ville, a.reference, a.prix,
                        raw_data::jsonb->'law' AS law,
                        p.nom AS portail_nom, p.login AS portail_login,
                        ap.statut
                 FROM annonces a
                 JOIN annonce_portails ap ON ap.annonce_id = a.id
                 JOIN portails p ON p.id = ap.portail_id
                 WHERE ap.statut IN ('publiee', 'envoyee')
                 ORDER BY a.id`
            )
            .all();

        const parAnnonce = {};
        for (const r of rows) {
            (parAnnonce[r.id] ??= { id: r.id, ville: r.ville, reference: r.reference, prix: r.prix, law: r.law, portails: [] }).portails.push({
                nom: r.portail_nom,
                login: r.portail_login,
                statut: r.statut,
            });
        }

        const malRoutees = [];
        for (const a of Object.values(parAnnonce)) {
            const estLmnp = typeof a.law === 'number' && (a.law & 4) === 4;
            const surLmnp = a.portails.some((p) => p.login === 'ag762215');
            const surNeuf = a.portails.some((p) => p.login === 'ag762216');
            if (estLmnp && surNeuf) malRoutees.push({ ...a, probleme: 'LMNP publié aussi sur Neuf' });
            else if (!estLmnp && surLmnp) malRoutees.push({ ...a, probleme: 'Non-LMNP publié sur LMNP' });
        }

        res.json({ totalAnnoncesPubliees: Object.keys(parAnnonce).length, nbMalRoutees: malRoutees.length, malRoutees });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const annonces = q
            ? await db
                  .prepare(
                      `SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces
                       WHERE CAST(id AS TEXT) LIKE ? OR titre LIKE ? OR ville LIKE ?
                       ORDER BY scrapee_le DESC LIMIT 200`
                  )
                  .all(`%${q}%`, `%${q}%`, `%${q}%`)
            : await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces ORDER BY scrapee_le DESC LIMIT 200`).all();
        
        const getInstances = db.prepare(
            `SELECT ap.*, p.nom AS portail_nom
             FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
             WHERE ap.annonce_id = ?
             ORDER BY p.nom`
        );

        const result = [];
        for (const a of annonces) {
            result.push({
                ...a,
                portails: await getInstances.all(a.id),
            });
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id', exigerConnexion, async (req, res) => {
    try {
        const { est_annonce_test } = req.body;
        if (est_annonce_test === undefined) {
            return res.status(400).json({ erreur: 'est_annonce_test requis' });
        }
        await db.prepare(`UPDATE annonces SET est_annonce_test = ? WHERE id = ?`).run(est_annonce_test ? 1 : 0, req.params.id);
        // Réponse jamais lue côté frontend (voir Supervision.jsx, onToggleTest) — pas la peine
        // de retransmettre images/raw_data pour une ligne dont le résultat est ignoré.
        res.json(await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id/portails/:portailId', exigerConnexion, async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['brouillon', 'actif'].includes(mode)) {
            return res.status(400).json({ erreur: "mode doit être 'brouillon' ou 'actif'" });
        }
        await db.prepare(
            `UPDATE annonce_portails SET mode = ?, maj_le = CURRENT_TIMESTAMP
             WHERE annonce_id = ? AND portail_id = ?`
        ).run(mode, req.params.id, req.params.portailId);
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/republish', exigerConnexion, async (req, res) => {
    try {
        await publierInstance(Number(req.params.id), Number(req.params.portailId));
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/depublier', exigerConnexion, async (req, res) => {
    try {
        const result = await depublierInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/synchroniser', exigerConnexion, async (req, res) => {
    try {
        const result = await synchroniserInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
