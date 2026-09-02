import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { IconAlert, IconRefresh } from './icons.jsx';

function formatEur(v) {
    return `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const then = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
    return then.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatMois(moisStr) {
    const d = new Date(moisStr);
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

// Section "Dépenses" de la page Réglages — plafond mensuel Neon + OpenAI avec arrêt automatique
// du pipeline (génération IA + auto-publication uniquement, jamais la recherche/import — voir
// orchestrator.js). Neon : chiffre officiel via son API de consommation, avec ~15 min de retard
// (d'où la marge de sécurité avant coupure). OpenAI : chiffre exact, calculé au fil de l'eau à
// chaque appel réel (voir Ubiflow-Auto-API/index.js).
export function DepenseConfig({ actif }) {
    const [etat, setEtat] = useState(null);
    const [erreur, setErreur] = useState(null);
    const [enCours, setEnCours] = useState(false);
    const [seuilNeon, setSeuilNeon] = useState('');
    const [seuilOpenai, setSeuilOpenai] = useState('');
    const [taux, setTaux] = useState('');
    const [marge, setMarge] = useState('');

    const refresh = useCallback(() => {
        api.getDepenses()
            .then((d) => {
                setEtat(d);
                setErreur(null);
                setSeuilNeon(String(d.parametres.seuil_neon_eur));
                setSeuilOpenai(String(d.parametres.seuil_openai_eur));
                setTaux(String(d.parametres.taux_usd_eur));
                setMarge(String(d.parametres.marge_pct));
            })
            .catch((e) => setErreur(e.message));
    }, []);

    // Gated par actif — voir le commentaire équivalent dans RoutingConfig.jsx.
    useEffect(() => {
        if (!actif) return;
        refresh();
    }, [actif, refresh]);

    async function onEnregistrerSeuils(e) {
        e.preventDefault();
        setErreur(null);
        try {
            await api.mettreAJourSeuilsDepense({
                seuil_neon_eur: Number(seuilNeon),
                seuil_openai_eur: Number(seuilOpenai),
                taux_usd_eur: Number(taux),
                marge_pct: Number(marge),
            });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onReprendre() {
        if (!window.confirm("Reprendre le pipeline malgré le plafond atteint ? Si la dépense réelle est toujours au-dessus du seuil, la pause pourra se redéclencher automatiquement au prochain contrôle.")) {
            return;
        }
        setErreur(null);
        try {
            await api.reprendreApresPause();
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onVerifierMaintenant() {
        setEnCours(true);
        setErreur(null);
        try {
            const d = await api.verifierDepensesMaintenant();
            setEtat(d);
        } catch (e) {
            setErreur(e.message);
        } finally {
            setEnCours(false);
        }
    }

    if (!etat) {
        return erreur ? <p className="text-error">{erreur}</p> : <p className="hint">Chargement…</p>;
    }

    const { parametres, pause, historique } = etat;
    const moisCourant = new Date().toISOString().slice(0, 8) + '01';
    const neonCourant = historique.find((h) => h.service === 'neon' && h.mois.slice(0, 10) === moisCourant);
    const openaiCourant = historique.find((h) => h.service === 'openai' && h.mois.slice(0, 10) === moisCourant);

    return (
        <div>
            <div className="field-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <p className="panel-section-title" style={{ marginBottom: 0 }}>Plafond de dépense mensuel</p>
                    <p className="hint">
                        Neon : chiffre officiel (API de consommation, ~15 min de retard). OpenAI : calculé au fil de
                        l'eau à partir des tokens réels de chaque appel — exact, pas une estimation.
                    </p>
                </div>
                <button type="button" className="btn btn-secondary" onClick={onVerifierMaintenant} disabled={enCours}>
                    <IconRefresh style={enCours ? { animation: 'spin 0.8s linear infinite' } : undefined} />
                    {enCours ? 'Vérification…' : 'Vérifier maintenant'}
                </button>
            </div>

            {pause?.en_pause && (
                <div className="alert alert-danger" style={{ marginTop: 12 }}>
                    <IconAlert />
                    <div>
                        <strong>Pipeline en pause — plafond de dépense atteint ({pause.service}).</strong>
                        <p className="hint" style={{ margin: '4px 0 8px' }}>
                            {pause.raison} Déclenché le {formatDate(pause.declenche_le)}. La génération IA et
                            l'auto-publication sont arrêtées ; la recherche reste disponible normalement.
                        </p>
                        <button type="button" className="btn btn-primary" onClick={onReprendre}>
                            Reprendre
                        </button>
                    </div>
                </div>
            )}

            <div className="stat-grid" style={{ marginTop: 16 }}>
                <div className="stat-card">
                    <span className="stat-label">Neon — mois en cours</span>
                    <span className="stat-value">{formatEur(neonCourant?.cout_estime_eur ?? 0)}</span>
                    <span className="cell-muted">Seuil : {formatEur(parametres.seuil_neon_eur)}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">OpenAI — mois en cours</span>
                    <span className="stat-value">{formatEur(openaiCourant?.cout_estime_eur ?? 0)}</span>
                    <span className="cell-muted">Seuil : {formatEur(parametres.seuil_openai_eur)}</span>
                </div>
            </div>

            <form className="field-row" style={{ marginTop: 16, flexWrap: 'wrap' }} onSubmit={onEnregistrerSeuils}>
                <label className="field" style={{ width: 160 }}>
                    <span className="field-label">Seuil Neon (€)</span>
                    <input type="number" min="0" step="0.5" value={seuilNeon} onChange={(e) => setSeuilNeon(e.target.value)} />
                </label>
                <label className="field" style={{ width: 160 }}>
                    <span className="field-label">Seuil OpenAI (€)</span>
                    <input type="number" min="0" step="0.5" value={seuilOpenai} onChange={(e) => setSeuilOpenai(e.target.value)} />
                </label>
                <label className="field" style={{ width: 160 }} title="Neon/OpenAI facturent en dollars — taux fixe utilisé pour convertir en euros, pas d'appel à une API de change externe.">
                    <span className="field-label">Taux $→€</span>
                    <input type="number" min="0" step="0.01" value={taux} onChange={(e) => setTaux(e.target.value)} />
                </label>
                <label className="field" style={{ width: 160 }} title="La pause se déclenche à ce pourcentage du seuil, pas à 100% pile, pour absorber le délai de ~15 min des chiffres Neon.">
                    <span className="field-label">Marge de sécurité (%)</span>
                    <input type="number" min="1" max="100" step="1" value={marge} onChange={(e) => setMarge(e.target.value)} />
                </label>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }}>
                    Enregistrer
                </button>
            </form>

            {historique.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 16 }}>
                    <table>
                        <thead>
                            <tr>
                                <th>Mois</th>
                                <th>Service</th>
                                <th>Dépense estimée</th>
                                <th>Dernière mise à jour</th>
                            </tr>
                        </thead>
                        <tbody>
                            {historique.map((h) => (
                                <tr key={`${h.mois}-${h.service}`}>
                                    <td style={{ textTransform: 'capitalize' }}>{formatMois(h.mois)}</td>
                                    <td className="cell-muted" style={{ textTransform: 'capitalize' }}>{h.service}</td>
                                    <td>{formatEur(h.cout_estime_eur)}</td>
                                    <td className="cell-muted">{formatDate(h.maj_le)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {erreur && <p className="text-error">{erreur}</p>}
        </div>
    );
}
