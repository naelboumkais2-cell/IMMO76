import { Router } from 'express';
import { db } from '../db.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';

export const annoncesRouter = Router();

// Liste des annonces avec, pour chacune, le statut par portail (pas un statut unique).
// Sans `q` : les 200 plus récentes (comportement historique). Avec `q` : recherche par
// id/titre/ville sur toute la base — nécessaire dès que la base dépasse 200 lignes (imports
// Otaree en masse), sinon une annonce ancienne devient invisible et impossible à retrouver.
annoncesRouter.get('/', (req, res) => {
    const q = (req.query.q || '').trim();
    const annonces = q
        ? db
              .prepare(
                  `SELECT * FROM annonces
                   WHERE CAST(id AS TEXT) LIKE ? OR titre LIKE ? OR ville LIKE ?
                   ORDER BY scrapee_le DESC LIMIT 200`
              )
              .all(`%${q}%`, `%${q}%`, `%${q}%`)
        : db.prepare(`SELECT * FROM annonces ORDER BY scrapee_le DESC LIMIT 200`).all();
    const getInstances = db.prepare(
        `SELECT ap.*, p.nom AS portail_nom
         FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
         WHERE ap.annonce_id = ?
         ORDER BY p.nom`
    );

    const result = annonces.map((a) => ({
        ...a,
        portails: getInstances.all(a.id),
    }));

    res.json(result);
});

// Marque/démarque une annonce comme "annonce de test" — seule cette whitelist explicite
// permet à hubiflowClientReel.js de déclencher un vrai appel réseau vers Hubiflow en mode
// réel. Jamais mis à 1 automatiquement par le scraper.
annoncesRouter.put('/:id', (req, res) => {
    const { est_annonce_test } = req.body;
    if (est_annonce_test === undefined) {
        return res.status(400).json({ erreur: 'est_annonce_test requis' });
    }
    db.prepare(`UPDATE annonces SET est_annonce_test = ? WHERE id = ?`).run(est_annonce_test ? 1 : 0, req.params.id);
    res.json(db.prepare(`SELECT * FROM annonces WHERE id = ?`).get(req.params.id));
});

// Changer le mode (brouillon/actif) d'une instance (annonce, portail) ponctuellement.
annoncesRouter.put('/:id/portails/:portailId', (req, res) => {
    const { mode } = req.body;
    if (!['brouillon', 'actif'].includes(mode)) {
        return res.status(400).json({ erreur: "mode doit être 'brouillon' ou 'actif'" });
    }
    db.prepare(
        `UPDATE annonce_portails SET mode = ?, maj_le = datetime('now')
         WHERE annonce_id = ? AND portail_id = ?`
    ).run(mode, req.params.id, req.params.portailId);
    res.json(
        db
            .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
            .get(req.params.id, req.params.portailId)
    );
});

// Republish manuel et ponctuel — optionnel, ne fait pas partie du flux automatique par défaut.
annoncesRouter.post('/:id/portails/:portailId/republish', async (req, res) => {
    try {
        await publierInstance(Number(req.params.id), Number(req.params.portailId));
        res.json(
            db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Retour arrière immédiat : dépublie/supprime sur Hubiflow — pour agir vite si le contenu pose
// problème une fois en actif. Ne régénère rien, n'a besoin que de l'ad_id_externe déjà connu.
annoncesRouter.post('/:id/portails/:portailId/depublier', async (req, res) => {
    try {
        const result = await depublierInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Resynchronisation manuelle : relit l'état réel sur Hubiflow (lecture seule) et met à jour
// statut/etat_hubiflow_confirme — pour refléter un changement fait directement sur Hubiflow.
annoncesRouter.post('/:id/portails/:portailId/synchroniser', async (req, res) => {
    try {
        const result = await synchroniserInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
