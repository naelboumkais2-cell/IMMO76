import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';

export const annoncesRouter = Router();

// TEMPORAIRE — diagnostic des lots publiés sans photo sur la recherche Bordeaux (voir demande du
// 2026-09-06). Renvoie, pour chaque annonce de la recherche : combien de photos Otaree a fourni
// (raw_data.images), combien ont été stockées après téléchargement (images), la référence
// utilisée, et le statut de publication par portail. Lecture seule.
annoncesRouter.get('/diag-photos/:rechercheId', exigerConnexion, async (req, res) => {
    try {
        const rows = await db
            .prepare(
                `SELECT id, titre, reference, reference_generee, raw_data, images, scrapee_le
                 FROM annonces WHERE recherche_id = ? ORDER BY id`
            )
            .all(req.params.rechercheId);
        const getPortails = db.prepare(
            `SELECT ap.statut, ap.mode, ap.ad_id_externe, ap.maj_le, p.nom AS portail_nom
             FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
             WHERE ap.annonce_id = ?`
        );
        const result = [];
        for (const r of rows) {
            let nbPhotosOtaree = null;
            try {
                const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
                nbPhotosOtaree = Array.isArray(raw?.images) ? raw.images.length : null;
            } catch (e) { /* ignore */ }
            let nbPhotosStockees = null;
            try {
                const imgs = typeof r.images === 'string' ? JSON.parse(r.images) : r.images;
                nbPhotosStockees = Array.isArray(imgs) ? imgs.length : null;
            } catch (e) { /* ignore */ }
            result.push({
                id: r.id,
                titre: r.titre,
                reference: r.reference,
                reference_generee: r.reference_generee,
                scrapee_le: r.scrapee_le,
                nbPhotosOtaree,
                nbPhotosStockees,
                portails: await getPortails.all(r.id),
            });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — logs_api complets liés à une annonce précise (pas seulement les 200 derniers
// toutes annonces confondues comme /api/logs) — pour retrouver l'erreur exacte au moment du
// traitement d'un lot précis, même si elle est sortie de la fenêtre des 200 logs les plus récents.
annoncesRouter.get('/diag-logs/:id', exigerConnexion, async (req, res) => {
    try {
        const logs = await db
            .prepare(`SELECT * FROM logs_api WHERE annonce_id = ? ORDER BY id`)
            .all(req.params.id);
        res.json(logs);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Colonnes explicites, sans `images`/`raw_data`/`donnees_ia` — Supervision (le seul appelant,
// voir Supervision.jsx) n'affiche qu'un tableau de statuts, jamais les photos. `images` seule
// peut peser plusieurs Mo par annonce (jusqu'à 20 photos en base64) : avec LIMIT 200 et un
// rafraîchissement automatique toutes les 5s pendant que l'onglet est ouvert, un `SELECT *` ici
// pouvait retransmettre plusieurs centaines de Mo par minute — identifié comme responsable
// d'un dépassement réel du quota de transfert Neon.
const COLONNES_LISTE_ANNONCES = 'id, external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, scrapee_le, est_annonce_test, alerte_document';

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
