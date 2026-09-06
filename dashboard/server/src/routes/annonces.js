import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';

export const annoncesRouter = Router();

// TEMPORAIRE — rattrape les photos manquantes d'une annonce déjà réellement publiée sur Hubiflow
// (voir enrichirLot/rate-limit Otaree, 2026-09-06). Ne touche jamais texte/prix/statut : (1)
// retélécharge les photos depuis raw_data (déjà réenrichi) sans passer par /api/generate, donc
// sans régénérer le texte, (2) met à jour la colonne `images`, (3) envoie ces photos à Hubiflow
// via le PATCH strictement borné /api/annonce/:id/photos (voir patcherPhotosHubiflow,
// Ubiflow-Auto-API/index.js). À retirer une fois les 104 lots traités.
annoncesRouter.post('/:id/diag-patch-photos', exigerConnexion, async (req, res) => {
    try {
        const annonce = await db.prepare(`SELECT raw_data FROM annonces WHERE id = ?`).get(req.params.id);
        if (!annonce) return res.status(404).json({ erreur: 'Annonce introuvable.' });

        const instance = await db
            .prepare(
                `SELECT ap.ad_id_externe, p.login AS portail_login, p.nom AS portail_nom
                 FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
                 WHERE ap.annonce_id = ? AND ap.ad_id_externe IS NOT NULL
                 ORDER BY ap.id LIMIT 1`
            )
            .get(req.params.id);
        if (!instance) return res.status(400).json({ erreur: 'Aucun ad_id_externe trouvé pour cette annonce (jamais publiée réellement ?).' });

        const lot = typeof annonce.raw_data === 'string' ? JSON.parse(annonce.raw_data) : annonce.raw_data;
        const serverUrl = process.env.UBIFLOW_AUTO_API_URL || 'http://localhost:4000';

        const rTelecharge = await fetch(`${serverUrl}/api/telecharger-photos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lot }),
        });
        const dataTelecharge = await rTelecharge.json();
        if (!rTelecharge.ok || !dataTelecharge.success) {
            return res.status(502).json({ erreur: `Échec téléchargement photos : ${dataTelecharge.error || rTelecharge.status}` });
        }
        const base64Images = dataTelecharge.images;
        if (!base64Images.length) {
            return res.status(400).json({ erreur: 'Aucune photo téléchargée — raw_data ne contient toujours aucune image.' });
        }
        await db.prepare(`UPDATE annonces SET images = ? WHERE id = ?`).run(JSON.stringify(base64Images), req.params.id);

        const rPatch = await fetch(`${serverUrl}/api/annonce/${instance.ad_id_externe}/photos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64Images, espaceLoginAttendu: instance.portail_login }),
        });
        const dataPatch = await rPatch.json();

        res.status(rPatch.ok ? 200 : 502).json({
            nbPhotosTelechargees: base64Images.length,
            adIdExterne: instance.ad_id_externe,
            portail: instance.portail_nom,
            patchHubiflow: dataPatch,
        });
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
