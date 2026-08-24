import { useState } from 'react';
import { api } from '../api.js';

// Mur de connexion — affiché à la place de toute l'app tant qu'aucune session valide n'existe
// (voir App.jsx). Pas d'inscription libre : "S'inscrire" ci-dessous ouvre un formulaire de
// création de compte protégé par la clé admin (voir routes/auth.js, POST /comptes) — un simple
// visiteur sans cette clé ne peut créer aucun compte, ça reste toi qui gardes le contrôle des
// accès, juste avec un formulaire plutôt qu'une commande à taper.
export function Login({ onConnecte }) {
    const [vue, setVue] = useState('connexion');

    return (
        <div className="login-ecran">
            <div className="login-carte">
                <div className="recherche-accueil-mark">76</div>
                <h1 className="recherche-accueil-titre">IMMO76</h1>
                {vue === 'connexion' ? (
                    <FormulaireConnexion onConnecte={onConnecte} />
                ) : (
                    <FormulaireInscription onCompteCree={() => setVue('connexion')} />
                )}
                <button
                    type="button"
                    className="btn-retour"
                    style={{ marginTop: 0 }}
                    onClick={() => setVue(vue === 'connexion' ? 'inscription' : 'connexion')}
                >
                    {vue === 'connexion' ? "S'inscrire (avec la clé admin)" : '← Retour à la connexion'}
                </button>
            </div>
        </div>
    );
}

function FormulaireConnexion({ onConnecte }) {
    const [email, setEmail] = useState('');
    const [motDePasse, setMotDePasse] = useState('');
    const [enCours, setEnCours] = useState(false);
    const [erreur, setErreur] = useState(null);

    async function onSubmit(e) {
        e.preventDefault();
        setErreur(null);
        setEnCours(true);
        try {
            const utilisateur = await api.login(email.trim(), motDePasse);
            onConnecte(utilisateur);
        } catch (err) {
            setErreur(err.message);
        } finally {
            setEnCours(false);
        }
    }

    return (
        <form onSubmit={onSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p className="recherche-accueil-soustitre">Connexion à ton espace</p>

            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Email</span>
                <input
                    type="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                />
            </label>
            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Mot de passe</span>
                <input
                    type="password"
                    required
                    value={motDePasse}
                    onChange={(e) => setMotDePasse(e.target.value)}
                    autoComplete="current-password"
                />
            </label>

            {erreur && <p className="text-error">{erreur}</p>}

            <button type="submit" className="btn btn-primary" disabled={enCours} style={{ width: '100%', justifyContent: 'center' }}>
                {enCours ? 'Connexion…' : 'Se connecter'}
            </button>
        </form>
    );
}

function FormulaireInscription({ onCompteCree }) {
    const [cleAdmin, setCleAdmin] = useState('');
    const [email, setEmail] = useState('');
    const [motDePasse, setMotDePasse] = useState('');
    const [nom, setNom] = useState('');
    const [enCours, setEnCours] = useState(false);
    const [erreur, setErreur] = useState(null);
    const [succes, setSucces] = useState(null);

    async function onSubmit(e) {
        e.preventDefault();
        setErreur(null);
        setSucces(null);
        setEnCours(true);
        try {
            const compte = await api.creerCompte(cleAdmin, email.trim(), motDePasse, nom.trim() || null);
            setSucces(`Compte créé pour ${compte.email} — tu peux maintenant te connecter avec.`);
            setEmail('');
            setMotDePasse('');
            setNom('');
            setTimeout(onCompteCree, 1500);
        } catch (err) {
            setErreur(err.message);
        } finally {
            setEnCours(false);
        }
    }

    return (
        <form onSubmit={onSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p className="recherche-accueil-soustitre">Créer un compte employé</p>
            <p className="hint">Réservé à toi (la personne qui gère l'accès de l'équipe) — nécessite ta clé admin.</p>

            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Clé admin</span>
                <input
                    type="password"
                    autoFocus
                    required
                    value={cleAdmin}
                    onChange={(e) => setCleAdmin(e.target.value)}
                    autoComplete="off"
                />
            </label>
            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Nom (optionnel)</span>
                <input value={nom} onChange={(e) => setNom(e.target.value)} autoComplete="off" />
            </label>
            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Email du nouveau compte</span>
                <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                />
            </label>
            <label className="field" style={{ width: '100%' }}>
                <span className="field-label">Mot de passe (8 caractères min.)</span>
                <input
                    type="password"
                    required
                    minLength={8}
                    value={motDePasse}
                    onChange={(e) => setMotDePasse(e.target.value)}
                    autoComplete="new-password"
                />
            </label>

            {erreur && <p className="text-error">{erreur}</p>}
            {succes && <p className="hint" style={{ color: 'var(--success)' }}>{succes}</p>}

            <button type="submit" className="btn btn-primary" disabled={enCours} style={{ width: '100%', justifyContent: 'center' }}>
                {enCours ? 'Création…' : 'Créer le compte'}
            </button>
        </form>
    );
}
