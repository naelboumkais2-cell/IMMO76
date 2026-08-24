import { Router } from 'express';
import { db } from '../db.js';
import {
    hacherMotDePasse,
    verifierMotDePasse,
    creerSession,
    supprimerSession,
    supprimerSessionsUtilisateur,
    resoudreUtilisateurDepuisJeton,
    optionsCookie,
    NOM_COOKIE,
} from '../services/authService.js';
import { exigerCleAdmin } from '../middleware/auth.js';

export const authRouter = Router();

function estLocal(req) {
    return !req.secure && req.hostname === 'localhost';
}

async function journaliserConnexion(utilisateurId, type, req, emailTente = null) {
    await db
        .prepare(`INSERT INTO connexions_log (utilisateur_id, type, email_tente, ip) VALUES (?, ?, ?, ?)`)
        .run(utilisateurId, type, emailTente, req.ip || null);
}

// Pas de mur de connexion ici, évidemment — c'est le point d'entrée qui le pose.
authRouter.post('/login', async (req, res) => {
    const { email, motDePasse } = req.body || {};
    if (!email || !motDePasse) {
        return res.status(400).json({ erreur: 'email et motDePasse requis.' });
    }

    const utilisateur = await db.prepare(`SELECT * FROM utilisateurs WHERE email = ? AND actif = 1`).get(email.trim().toLowerCase());
    const motDePasseValide = utilisateur ? await verifierMotDePasse(motDePasse, utilisateur.mot_de_passe_hash) : false;

    if (!utilisateur || !motDePasseValide) {
        await journaliserConnexion(utilisateur?.id ?? null, 'echec_connexion', req, email);
        // Message volontairement identique que ce soit l'email ou le mot de passe qui soit
        // faux — ne pas révéler quels emails ont un compte existant.
        return res.status(401).json({ erreur: 'Email ou mot de passe incorrect.' });
    }

    const { jeton, expireLe } = await creerSession(utilisateur.id);
    await journaliserConnexion(utilisateur.id, 'connexion', req);
    res.cookie(NOM_COOKIE, jeton, optionsCookie(estLocal(req), expireLe));
    res.json({ id: utilisateur.id, email: utilisateur.email, nom: utilisateur.nom });
});

authRouter.post('/logout', async (req, res) => {
    const jeton = req.cookies?.[NOM_COOKIE];
    if (jeton) {
        await supprimerSession(jeton);
        res.clearCookie(NOM_COOKIE, { path: '/' });
    }
    res.json({ success: true });
});

// Interrogé par le frontend au chargement pour savoir s'il y a une session valide, et par qui —
// pas derrière exigerConnexion (sinon un utilisateur non connecté recevrait un 401 générique
// au lieu de pouvoir distinguer "pas connecté" de "erreur serveur").
authRouter.get('/moi', async (req, res) => {
    let utilisateur;
    try {
        utilisateur = await resoudreUtilisateurDepuisJeton(req.cookies?.[NOM_COOKIE]);
    } catch (e) {
        // Voir le même correctif dans middleware/auth.js — sans ça, une base de données
        // injoignable (quota Neon dépassé, etc.) laisse le frontend bloqué indéfiniment sur
        // l'écran de chargement au lieu d'afficher clairement le problème.
        console.error('[auth/moi] erreur en résolvant la session :', e.message);
        return res.status(503).json({ erreur: 'Service temporairement indisponible (base de données injoignable).' });
    }
    if (!utilisateur) return res.status(401).json({ erreur: 'Non connecté.' });
    res.json(utilisateur);
});

// Gestion des comptes — protégée par une clé d'admin séparée (voir exigerCleAdmin), pas par une
// session utilisateur classique : au tout premier lancement, aucun compte n'existe encore.
authRouter.post('/comptes', exigerCleAdmin, async (req, res) => {
    const { email, motDePasse, nom } = req.body || {};
    if (!email || !motDePasse) {
        return res.status(400).json({ erreur: 'email et motDePasse requis.' });
    }
    if (motDePasse.length < 8) {
        return res.status(400).json({ erreur: 'Le mot de passe doit faire au moins 8 caractères.' });
    }
    const hash = await hacherMotDePasse(motDePasse);
    try {
        const info = await db
            .prepare(`INSERT INTO utilisateurs (email, mot_de_passe_hash, nom) VALUES (?, ?, ?)`)
            .run(email.trim().toLowerCase(), hash, nom || null);
        res.status(201).json(await db.prepare(`SELECT id, email, nom, actif FROM utilisateurs WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
        if (String(e.message).includes('duplicate key')) {
            return res.status(409).json({ erreur: 'Un compte existe déjà avec cet email.' });
        }
        res.status(500).json({ erreur: e.message });
    }
});

authRouter.get('/comptes', exigerCleAdmin, async (req, res) => {
    res.json(await db.prepare(`SELECT id, email, nom, actif, cree_le FROM utilisateurs ORDER BY cree_le DESC`).all());
});

// Désactiver/réactiver un compte (jamais de suppression, voir db.js) — coupe aussi ses sessions
// en cours immédiatement en cas de désactivation, pour un effet réel tout de suite plutôt que
// d'attendre l'expiration naturelle du cookie déjà émis.
authRouter.put('/comptes/:id', exigerCleAdmin, async (req, res) => {
    const { actif } = req.body || {};
    await db.prepare(`UPDATE utilisateurs SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, req.params.id);
    if (!actif) await supprimerSessionsUtilisateur(req.params.id);
    res.json(await db.prepare(`SELECT id, email, nom, actif FROM utilisateurs WHERE id = ?`).get(req.params.id));
});
