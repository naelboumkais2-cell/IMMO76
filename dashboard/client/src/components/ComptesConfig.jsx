import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const then = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
    return then.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Section "Comptes" de la page Réglages — remplace la création de comptes par curl (clé admin).
// N'est rendue par RoutingConfig que si utilisateur.role === 'admin' (côté client, confort
// d'affichage) ; le vrai contrôle est côté serveur (exigerAdmin, 403 pour un compte employe même
// en appelant la route directement) — voir middleware/auth.js.
export function ComptesConfig() {
    const [comptes, setComptes] = useState(null);
    const [erreur, setErreur] = useState(null);
    const [email, setEmail] = useState('');
    const [motDePasse, setMotDePasse] = useState('');
    const [nom, setNom] = useState('');
    const [creationEnCours, setCreationEnCours] = useState(false);

    const refresh = useCallback(() => {
        api.getComptes()
            .then((c) => {
                setComptes(c);
                setErreur(null);
            })
            .catch((e) => setErreur(e.message));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function onCreerCompte(e) {
        e.preventDefault();
        if (!email.trim() || !motDePasse) {
            setErreur('Email et mot de passe requis.');
            return;
        }
        setCreationEnCours(true);
        setErreur(null);
        try {
            await api.creerCompteAdmin(email.trim(), motDePasse, nom.trim() || null);
            setEmail('');
            setMotDePasse('');
            setNom('');
            refresh();
        } catch (e) {
            setErreur(e.message);
        } finally {
            setCreationEnCours(false);
        }
    }

    async function onToggleActif(compte) {
        const action = compte.actif ? 'désactiver' : 'réactiver';
        if (!window.confirm(`Confirmer : ${action} le compte ${compte.email} ?`)) return;
        try {
            await api.toggleCompteActif(compte.id, !compte.actif);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    return (
        <div>
            <p className="panel-section-title">Comptes</p>
            <p className="hint">
                Gestion des comptes employés — chacun garde exactement les mêmes droits (recherche,
                publication incluse), le rôle ne sert qu'à qui peut gérer les comptes ici.
            </p>

            <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Nom</th>
                            <th>Rôle</th>
                            <th>Statut</th>
                            <th>Créé le</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {(comptes || []).map((c) => (
                            <tr key={c.id}>
                                <td>{c.email}</td>
                                <td className="cell-muted">{c.nom || '—'}</td>
                                <td className="cell-muted" style={{ textTransform: 'capitalize' }}>{c.role}</td>
                                <td>
                                    <span className={c.actif ? 'badge badge-publiee' : 'badge badge-depubliee'}>
                                        {c.actif ? 'Actif' : 'Désactivé'}
                                    </span>
                                </td>
                                <td className="cell-muted">{formatDate(c.cree_le)}</td>
                                <td className="col-tight">
                                    <button type="button" className="btn btn-secondary" onClick={() => onToggleActif(c)}>
                                        {c.actif ? 'Désactiver' : 'Réactiver'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {comptes && comptes.length === 0 && (
                            <tr className="empty-row">
                                <td colSpan={6}>Aucun compte.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <form className="field-row" style={{ marginTop: 16, flexWrap: 'wrap' }} onSubmit={onCreerCompte}>
                <label className="field" style={{ width: 220 }}>
                    <span className="field-label">Email</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@plusimmo76.fr" />
                </label>
                <label className="field" style={{ width: 180 }}>
                    <span className="field-label">Mot de passe</span>
                    <input
                        type="password"
                        value={motDePasse}
                        onChange={(e) => setMotDePasse(e.target.value)}
                        placeholder="8 caractères min."
                    />
                </label>
                <label className="field" style={{ width: 160 }}>
                    <span className="field-label">Nom (optionnel)</span>
                    <input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Prénom Nom" />
                </label>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={creationEnCours}>
                    {creationEnCours ? 'Création…' : 'Créer le compte'}
                </button>
            </form>

            {erreur && <p className="text-error">{erreur}</p>}
        </div>
    );
}
