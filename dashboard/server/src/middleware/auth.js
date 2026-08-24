import crypto from 'node:crypto';
import { NOM_COOKIE, resoudreUtilisateurDepuisJeton } from '../services/authService.js';
import { executerAvecUtilisateur } from '../services/requestContext.js';

// Mur de connexion : appliqué à toutes les routes humaines (voir index.js). Bloque
// systématiquement (401) sans session valide, y compris en lecture — c'est le point explicite
// de ce chantier (avant : rien n'exigeait de connexion). N'est PAS appliqué aux routes machine
// (import Otaree, capture de token, cron programmé) qui n'ont jamais d'humain connecté derrière
// — voir exigerCleMachine, une protection différente pour celles-là.
//
// Pose aussi le contexte de requête (voir requestContext.js) : le reste de la chaîne d'appels
// (route -> orchestrator.js -> log()) peut ainsi savoir qui a déclenché l'action sans qu'aucune
// fonction intermédiaire n'ait besoin de connaître l'existence de l'authentification.
export async function exigerConnexion(req, res, next) {
    const jeton = req.cookies?.[NOM_COOKIE];
    let utilisateur;
    try {
        utilisateur = await resoudreUtilisateurDepuisJeton(jeton);
    } catch (e) {
        // Sans ce try/catch, une erreur ici (ex: base de données indisponible) fait rejeter
        // cette fonction async sans qu'Express (v4) ne la rattrape automatiquement — la requête
        // reste bloquée indéfiniment côté navigateur ("provisional headers", jamais de réponse)
        // au lieu d'afficher une vraie erreur. Constaté en conditions réelles (quota Neon
        // dépassé) : l'app entière semblait "figée" plutôt que de signaler clairement la panne.
        console.error('[exigerConnexion] erreur en résolvant la session :', e.message);
        return res.status(503).json({ erreur: 'Service temporairement indisponible (base de données injoignable).' });
    }
    if (!utilisateur) {
        return res.status(401).json({ erreur: 'Connexion requise.' });
    }
    req.utilisateur = utilisateur;
    executerAvecUtilisateur(utilisateur.id, next);
}

// Protège les routes appelées par des scripts automatiques (extensions Chrome, cron
// programmé) — jamais un humain avec une session, donc pas de mur de connexion ici, mais pas
// non plus grand ouvert : une clé secrète partagée (env var), envoyée en en-tête par
// l'appelant. Comparaison à temps constant pour éviter une fuite d'information par timing.
export function exigerCleMachine(req, res, next) {
    const cleAttendue = process.env.MACHINE_API_KEY;
    if (!cleAttendue) {
        // Pas de clé configurée : on refuse plutôt que de laisser la route grande ouverte par
        // défaut — un oubli de configuration ne doit jamais se traduire par "pas de protection".
        return res.status(500).json({ erreur: 'MACHINE_API_KEY non configurée côté serveur.' });
    }
    const cleRecue = req.get('X-Machine-Key') || '';
    const buf1 = Buffer.from(cleRecue);
    const buf2 = Buffer.from(cleAttendue);
    const valide = buf1.length === buf2.length && crypto.timingSafeEqual(buf1, buf2);
    if (!valide) {
        return res.status(401).json({ erreur: 'Clé invalide.' });
    }
    next();
}

// Protège la création/gestion des comptes employés (voir routes/auth.js, POST /comptes) — clé
// distincte de MACHINE_API_KEY (rôles différents : celle-ci n'est connue que de toi, jamais
// distribuée à une extension ou un script). Volontairement pas liée à une session utilisateur
// classique : au tout premier lancement, aucun compte n'existe encore pour se connecter et en
// créer un autre — cette clé est le seul point d'entrée indépendant de ce problème d'œuf/poule.
export function exigerCleAdmin(req, res, next) {
    const cleAttendue = process.env.ADMIN_SECRET;
    if (!cleAttendue) {
        return res.status(500).json({ erreur: 'ADMIN_SECRET non configurée côté serveur.' });
    }
    const cleRecue = req.get('X-Admin-Key') || '';
    const buf1 = Buffer.from(cleRecue);
    const buf2 = Buffer.from(cleAttendue);
    const valide = buf1.length === buf2.length && crypto.timingSafeEqual(buf1, buf2);
    if (!valide) {
        return res.status(401).json({ erreur: 'Clé invalide.' });
    }
    next();
}
