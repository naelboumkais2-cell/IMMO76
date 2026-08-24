import { useState } from 'react';
import { api } from '../api.js';

// Mur de connexion — affiché à la place de toute l'app tant qu'aucune session valide n'existe
// (voir App.jsx). Pas d'inscription libre : les comptes sont créés par un administrateur (voir
// routes/auth.js, POST /comptes protégé par clé), un employé ne peut que se connecter ici.
export function Login({ onConnecte }) {
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
        <div className="login-ecran">
            <form className="login-carte" onSubmit={onSubmit}>
                <div className="recherche-accueil-mark">76</div>
                <h1 className="recherche-accueil-titre">IMMO76</h1>
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
        </div>
    );
}
