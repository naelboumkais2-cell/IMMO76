import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { IconRoute, IconPlus, IconTrash } from './icons.jsx';
import { Select } from './Select.jsx';
import { Overlay } from './Overlay.jsx';
import { DepenseConfig } from './DepenseConfig.jsx';

const TYPES_BIEN = ['Studio', 'T1', 'T2', 'T3', 'Maison'];

const MODE_DEFAUT_OPTIONS = [
    { value: 'brouillon', label: 'Brouillon' },
    {
        value: 'actif',
        label: 'Annonce active',
        title: "L'écran de confirmation (portails/mode par lot, modifiable) s'affiche désormais systématiquement avant toute publication réelle — un défaut de portail sur 'actif' ne publie donc jamais rien sans validation humaine explicite.",
    },
];

export function RoutingConfig() {
    const [portails, setPortails] = useState([]);
    const [regles, setRegles] = useState([]);
    const [nouveauNom, setNouveauNom] = useState('');
    const [nouveauLogin, setNouveauLogin] = useState('');
    const [erreur, setErreur] = useState(null);
    const [regleType, setRegleType] = useState('');
    const [reglePortail, setReglePortail] = useState('');
    const [regleDispositif, setRegleDispositif] = useState('');
    const [panneauRegleOuvert, setPanneauRegleOuvert] = useState(false);

    const refresh = useCallback(() => {
        Promise.all([api.getPortails(), api.getReglesRoutage()])
            .then(([p, r]) => {
                setPortails(p);
                setRegles(r);
                setErreur(null);
            })
            .catch((e) => setErreur(e.message));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function onCreatePortail(e) {
        e.preventDefault();
        if (!nouveauNom.trim()) {
            setErreur('Le nom du portail est requis pour en ajouter un.');
            return;
        }
        try {
            await api.createPortail(nouveauNom.trim(), nouveauLogin.trim() || null, 'brouillon');
            setNouveauNom('');
            setNouveauLogin('');
            setErreur(null);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onTogglePortail(p) {
        try {
            await api.updatePortail(p.id, { actif: p.actif ? 0 : 1 });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onModeDefautChange(p, mode) {
        try {
            await api.updatePortail(p.id, { mode_publication_defaut: mode });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onNomBlur(p, value) {
        const nom = value.trim();
        if (!nom || nom === p.nom) return;
        try {
            await api.updatePortail(p.id, { nom });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onLoginBlur(p, value) {
        const login = value.trim();
        if (login === (p.login ?? '')) return;
        try {
            await api.updatePortail(p.id, { login: login || null });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onDeletePortail(id, nom) {
        if (!window.confirm(`Supprimer le portail "${nom}" ? Les annonces déjà routées vers lui perdront cette association.`)) {
            return;
        }
        try {
            await api.deletePortail(id);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onCreateRegle(e) {
        e.preventDefault();
        if (!reglePortail) {
            setErreur('Choisis un portail avant d\'ajouter la règle.');
            return;
        }
        try {
            await api.createRegleRoutage(regleType || null, Number(reglePortail), regleDispositif || null);
            setRegleType('');
            setReglePortail('');
            setRegleDispositif('');
            setErreur(null);
            setPanneauRegleOuvert(false);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onDeleteRegle(id) {
        if (!window.confirm('Supprimer cette règle de routage ?')) {
            return;
        }
        try {
            await api.deleteRegleRoutage(id);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    return (
        <section className="panel">
            <div className="panel-header">
                <div className="panel-icon">
                    <IconRoute />
                </div>
                <div className="panel-heading">
                    <h2>Portails Hubiflow</h2>
                    <p>
                        Les espaces Hubiflow de l'agence (un login = un compte, ex. ag762216) — pas des sites
                        d'annonces externes. Un seul est réellement actif à la fois côté serveur (un token = un espace).
                    </p>
                </div>
            </div>

            <div className="panel-body">
                <div>
                    <p className="panel-section-title">Portails (espaces Hubiflow)</p>
                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Portail</th>
                                    <th>Login</th>
                                    <th style={{ minWidth: 220 }}>Espace actif</th>
                                    <th>Actif</th>
                                    <th>Mode par défaut</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {portails.map((p) => (
                                    <tr key={p.id}>
                                        <td>
                                            <input
                                                key={p.nom}
                                                className="cell-input"
                                                defaultValue={p.nom}
                                                onBlur={(e) => onNomBlur(p, e.target.value)}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                key={p.login ?? ''}
                                                className="cell-input cell-input-mono"
                                                placeholder="ag76221X"
                                                defaultValue={p.login ?? ''}
                                                onBlur={(e) => onLoginBlur(p, e.target.value)}
                                            />
                                        </td>
                                        <td>
                                            {p.est_espace_actif ? (
                                                <span className="badge badge-espace-actif">Actif</span>
                                            ) : (
                                                <span className="hint-inline">
                                                    Pour publier ici, connecte-toi sur cet espace dans Chrome
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            <label className="switch">
                                                <input type="checkbox" checked={!!p.actif} onChange={() => onTogglePortail(p)} />
                                                <span className="switch-track" />
                                            </label>
                                        </td>
                                        <td>
                                            <Select
                                                value={p.mode_publication_defaut}
                                                onChange={(mode) => onModeDefautChange(p, mode)}
                                                options={MODE_DEFAUT_OPTIONS}
                                            />
                                        </td>
                                        <td className="col-tight">
                                            <button
                                                className="btn btn-ghost-danger btn-icon-only"
                                                onClick={() => onDeletePortail(p.id, p.nom)}
                                                title="Supprimer ce portail"
                                            >
                                                <IconTrash />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {portails.length === 0 && (
                                    <tr className="empty-row">
                                        <td colSpan={6}>Aucun portail configuré.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <p className="hint">
                        L'espace actif reflète en direct le token réellement chargé côté serveur
                        (Ubiflow-Auto-API/token.json) — il n'y a pas de bascule automatique depuis le dashboard,
                        la connexion se fait manuellement dans Chrome, comme aujourd'hui.
                    </p>
                    <p className="hint">
                        « Annonce active » comme mode par défaut de portail est désormais disponible (override
                        manuel par annonce toujours possible dans Supervision) — sûr depuis que l'écran de
                        confirmation (portails/mode par lot, modifiable) s'affiche systématiquement avant toute
                        publication réelle : aucun lot ne part plus jamais vers Hubiflow sans validation humaine
                        explicite, quel que soit le mode par défaut du portail.
                    </p>

                    <form className="field-row" style={{ marginTop: 12 }} onSubmit={onCreatePortail}>
                        <input
                            style={{ flex: 1, minWidth: 220 }}
                            placeholder="Nom du portail (ex : Plusimmo - La Centrale du Neuf)"
                            value={nouveauNom}
                            onChange={(e) => setNouveauNom(e.target.value)}
                        />
                        <input
                            style={{ width: 140 }}
                            placeholder="Login (ag76221X)"
                            value={nouveauLogin}
                            onChange={(e) => setNouveauLogin(e.target.value)}
                        />
                        <button type="submit" className="btn btn-secondary">
                            <IconPlus /> Ajouter un portail
                        </button>
                    </form>
                </div>

                <hr className="divider" />

                <div>
                    <div className="field-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <p className="panel-section-title" style={{ marginBottom: 0 }}>Règles de routage par défaut</p>
                            <p className="hint">
                                Détermine automatiquement vers quels portails router une annonce selon son type. Sans règle
                                correspondante, une annonce est diffusée vers tous les portails actifs.
                            </p>
                        </div>
                        <button type="button" className="btn btn-secondary" onClick={() => setPanneauRegleOuvert(true)}>
                            <IconPlus /> Ajouter une règle
                        </button>
                    </div>

                    <div className="table-wrap" style={{ marginTop: 12 }}>
                        <table>
                            <thead>
                                <tr>
                                    <th>Type de bien</th>
                                    <th>Dispositif</th>
                                    <th>Portail</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {regles.map((r) => (
                                    <tr key={r.id}>
                                        <td>{r.type_bien ?? 'Tous types'}</td>
                                        <td>{r.dispositif === 'lmnp' ? 'LMNP' : r.dispositif === 'non_lmnp' ? 'Non-LMNP' : 'Tous'}</td>
                                        <td>{r.portail_nom}</td>
                                        <td className="col-tight">
                                            <button
                                                className="btn btn-ghost-danger btn-icon-only"
                                                onClick={() => onDeleteRegle(r.id)}
                                                title="Supprimer cette règle"
                                            >
                                                <IconTrash />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {regles.length === 0 && (
                                    <tr className="empty-row">
                                        <td colSpan={4}>Aucune règle — toutes les annonces sont diffusées vers tous les portails actifs.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                </div>

                <hr className="divider" />

                <DepenseConfig />

                {erreur && <p className="text-error">{erreur}</p>}
            </div>

            {/* Création d'une règle de routage : conséquence réelle (change automatiquement où
                partent les futures annonces), traitée en plein écran comme les autres actions à
                conséquence réelle du dashboard — pas juste un petit formulaire discret. */}
            <Overlay open={panneauRegleOuvert} dismissible onDismiss={() => setPanneauRegleOuvert(false)} size="fullscreen">
                <h3>Ajouter une règle de routage</h3>
                <p className="hint">
                    Détermine automatiquement vers quels portails router une annonce selon son type. Sans règle
                    correspondante, une annonce est diffusée vers tous les portails actifs.
                </p>
                <form onSubmit={onCreateRegle}>
                    <div className="field-row" style={{ marginTop: 12 }}>
                        <Select
                            value={regleType}
                            onChange={setRegleType}
                            options={[{ value: '', label: 'Tous types' }, ...TYPES_BIEN.map((t) => ({ value: t, label: t }))]}
                            style={{ minWidth: 160 }}
                        />
                        <Select
                            value={regleDispositif}
                            onChange={setRegleDispositif}
                            options={[
                                { value: '', label: 'Tous dispositifs' },
                                { value: 'lmnp', label: 'LMNP' },
                                { value: 'non_lmnp', label: 'Non-LMNP' },
                            ]}
                            style={{ minWidth: 160 }}
                        />
                        <Select
                            value={reglePortail}
                            onChange={setReglePortail}
                            options={[
                                { value: '', label: 'Choisir un portail…' },
                                ...portails.map((p) => ({ value: String(p.id), label: p.nom })),
                            ]}
                            style={{ minWidth: 220 }}
                        />
                    </div>
                    <div className="modal-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => setPanneauRegleOuvert(false)}>
                            Annuler
                        </button>
                        <button type="submit" className="btn btn-primary">
                            <IconPlus /> Ajouter la règle
                        </button>
                    </div>
                </form>
            </Overlay>
        </section>
    );
}
