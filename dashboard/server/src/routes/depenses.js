import { Router } from 'express';
import { exigerConnexion } from '../middleware/auth.js';
import {
    obtenirEtatDepenses,
    mettreAJourParametres,
    leverPause,
    verifierEtMettreAJourDepenses,
} from '../services/depenseMonitor.js';

export const depensesRouter = Router();

// Même droits pour tous les employés connectés (pas de rôles, voir chantier authentification) —
// consulter/ajuster le plafond de dépense n'est pas traité différemment des autres réglages.
depensesRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        res.json(await obtenirEtatDepenses());
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

depensesRouter.put('/parametres', exigerConnexion, async (req, res) => {
    try {
        const { seuil_neon_eur, seuil_openai_eur, taux_usd_eur, marge_pct } = req.body || {};
        const params = await mettreAJourParametres({ seuil_neon_eur, seuil_openai_eur, taux_usd_eur, marge_pct });
        res.json(params);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Reprise manuelle uniquement (voir plan validé) — si la dépense réelle est toujours au-dessus
// du seuil, le prochain contrôle périodique repassera en pause tout seul.
depensesRouter.post('/reprendre', exigerConnexion, async (req, res) => {
    try {
        await leverPause();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Force un contrôle immédiat plutôt que d'attendre jusqu'à 10 min — utile juste après avoir
// changé un seuil, pour voir l'effet tout de suite dans Réglages.
depensesRouter.post('/verifier-maintenant', exigerConnexion, async (req, res) => {
    try {
        await verifierEtMettreAJourDepenses();
        res.json(await obtenirEtatDepenses());
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
