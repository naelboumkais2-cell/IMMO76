import json
import os
import urllib.request
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

# Fichier généré par l'extension
json_file = '/Users/clarencegomis/Downloads/otaree_full_extract_1783523547279.json'
# Dossier de destination sur le Bureau
output_dir = '/Users/clarencegomis/Desktop/Lots_Otaree'

os.makedirs(output_dir, exist_ok=True)

with open(json_file, 'r', encoding='utf-8') as f:
    lots = json.load(f)

print(f"Début du tri et téléchargement de {len(lots)} lots...")

# Ignorer la vérification SSL si problème avec certains Mac
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def download_file(url, dest_path):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx, timeout=15) as response, open(dest_path, 'wb') as out_file:
            out_file.write(response.read())
    except Exception as e:
        pass

download_tasks = []

for lot in lots:
    number = lot.get('number') or 'Inconnu'
    lot_id = lot.get('id', 'Inconnu')
    
    # Création du dossier du lot (ex: Lot_2214_a55121a9051b)
    lot_dir = os.path.join(output_dir, f"Lot_{number}_{lot_id}")
    os.makedirs(lot_dir, exist_ok=True)
    
    # --- 1. Génération de la fiche d'information (TXT) ---
    price = "Inconnu"
    if lot.get('prices') and len(lot['prices']) > 0:
        price = lot['prices'][0].get('price', "Inconnu")
        
    resume_path = os.path.join(lot_dir, "fiche_infos.txt")
    with open(resume_path, 'w', encoding='utf-8') as f:
        f.write(f"========== INFORMATIONS DU LOT ==========\n")
        f.write(f"ID Otaree : {lot_id}\n")
        f.write(f"Numéro : {number}\n")
        f.write(f"Typologie : {lot.get('typology', 'Inconnu')}\n")
        f.write(f"Surface totale : {lot.get('surface', 'Inconnu')} m²\n")
        f.write(f"Surface terrasse : {lot.get('terraceSurface', 'Inconnu')} m²\n")
        f.write(f"Pièces : {lot.get('roomsCount', 'Inconnu')}\n")
        f.write(f"Étage : {lot.get('floorLabel', 'Inconnu')}\n")
        f.write(f"Exposition : {', '.join(lot.get('exposures', []))}\n\n")
        
        f.write(f"========== PRIX & RENTABILITÉ ==========\n")
        f.write(f"Prix total : {price} €\n")
        f.write(f"Loi(s) : {', '.join(lot.get('laws', []))}\n")
        
        if lot.get('prices') and len(lot['prices']) > 0:
            price_info = lot['prices'][0]
            f.write(f"Rentabilité brute : {price_info.get('profitability', 'Inconnu')} %\n")
            f.write(f"Prix au m² : {price_info.get('squareMeterPrice', 'Inconnu')} €/m²\n")
            f.write(f"Loyer mensuel estimé : {price_info.get('monthlyRent', 'Inconnu')} €\n")
            if price_info.get('infos') and price_info['infos'].get('includedFurnituresPrice'):
                f.write(f"Dont prix des meubles : {price_info['infos']['includedFurnituresPrice'].get('price', 0)} €\n")

    # --- 2. Téléchargement du Plan (s'il existe) ---
    plan = lot.get('plan')
    if plan and plan.get('urls') and plan['urls'].get('download'):
        plan_url = plan['urls']['download']
        ext = "pdf" if "pdf" in plan.get('mimeType', '') else "jpg"
        download_tasks.append((plan_url, os.path.join(lot_dir, f"Plan_{number}.{ext}")))
            
    # --- 3. Téléchargement des Documents & Images annexes ---
    docs = lot.get('documents', [])
    for idx, doc in enumerate(docs):
        if doc.get('file') and doc['file'].get('urls') and doc['file']['urls'].get('download'):
            doc_url = doc['file']['urls']['download']
            ext = "pdf" if "pdf" in doc['file'].get('mimeType', '') else "jpg"
            type_label = doc.get('typeLabel', f'Doc_{idx+1}')
            safe_label = "".join(c for c in type_label if c.isalnum() or c in (' ', '_')).rstrip()
            download_tasks.append((doc_url, os.path.join(lot_dir, f"{safe_label}_{number}.{ext}")))

print(f"\n[INFO] {len(download_tasks)} fichiers à télécharger. Lancement du téléchargement parallèle...")

with ThreadPoolExecutor(max_workers=20) as executor:
    futures = [executor.submit(download_file, url, path) for url, path in download_tasks]
    for i, future in enumerate(as_completed(futures), 1):
        if i % 10 == 0 or i == len(download_tasks):
            print(f"Progression : {i} / {len(download_tasks)} fichiers téléchargés.")

print("\n🎉 Terminé ! Ton dossier 'Lots_Otaree' est prêt sur ton Bureau.")
