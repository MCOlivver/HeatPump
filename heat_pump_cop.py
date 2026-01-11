import requests
import datetime
from datetime import date, timedelta
import sys

def get_input(prompt, default, cast_func=str):
    """Helper to get user input with a default value."""
    user_input = input(f"{prompt} [Standard: {default}]: ")
    if not user_input.strip():
        return default
    try:
        return cast_func(user_input)
    except Exception:
        print(f"Ungültige Eingabe. Verwende Standardwert: {default}")
        return default

def get_date_input(prompt, default_date):
    """Helper for date input."""
    user_input = input(f"{prompt} (YYYY-MM-DD) [Standard: {default_date}]: ")
    if not user_input.strip():
        return default_date
    try:
        return datetime.datetime.strptime(user_input, "%Y-%m-%d").date()
    except ValueError:
        print(f"Falsches Format. Verwende Standarddatum: {default_date}")
        return default_date

def get_location_input(default_name="Hamburg", default_lat=53.5511, default_lon=9.9937):
    """Helper for location input (supports name geocoding or lat,lon)."""
    user_input = input(f"Ort eingeben (Name oder 'lat,lon') [Standard: {default_name}]: ").strip()
    
    if not user_input:
        return default_lat, default_lon
        
    # Check if input is "lat,lon"
    if ',' in user_input:
        try:
            parts = user_input.split(',')
            if len(parts) == 2:
                return float(parts[0].strip()), float(parts[1].strip())
        except ValueError:
            pass # Not a valid coordinate pair, treat as name
            
    # Treat as city name and use Geocoding API
    print(f"Suche Koordinaten für '{user_input}'...")
    try:
        geo_url = "https://geocoding-api.open-meteo.com/v1/search"
        params = {"name": user_input, "count": 1, "language": "de", "format": "json"}
        response = requests.get(geo_url, params=params)
        response.raise_for_status()
        data = response.json()
        
        if "results" in data and len(data["results"]) > 0:
            result = data["results"][0]
            lat = result["latitude"]
            lon = result["longitude"]
            name = result.get("name", user_input)
            country = result.get("country", "")
            print(f"Gefunden: {name}, {country} ({lat:.4f}, {lon:.4f})")
            return lat, lon
        else:
            print(f"Ort '{user_input}' nicht gefunden. Verwende Standard: {default_name}")
            return default_lat, default_lon
            
    except Exception as e:
        print(f"Fehler bei der Geocodierung: {e}. Verwende Standard.")
        return default_lat, default_lon

def main():
    print("--- Wärmepumpen-Rechner ---")
    
    # Calculate Date Defaults
    today = date.today()
    yesterday = today - timedelta(days=1)
    one_year_ago = yesterday - timedelta(days=365)
    
    # 1. User Inputs
    print("\nBitte Parameter eingeben:")
    
    eff = get_input("Effizienz (eff) [Wert 0-1, Carnot-Grad]", 0.5, float)
    
    # Dates
    print(f"\nZeitraum definieren (Beide Daten müssen in der Vergangenheit liegen).")
    datum_start = get_date_input("Startdatum", one_year_ago)
    datum_end = get_date_input("Enddatum", yesterday)
    
    # Validate Dates
    if datum_start >= datum_end:
        print("Fehler: Startdatum muss vor Enddatum liegen.")
        return
    if datum_end >= today:
        print("Warnung: Enddatum sollte in der Vergangenheit liegen für historische Daten.")
    
    # Building Params
    temp_innen = get_input("Innentemperatur (tempInnen) in °C", 20.0, float)
    
    print("\nHeizkurve: tempVorlauf = a * (tempInnen - tempAussen) + b")
    a = get_input("Parameter a", 1.0, float)
    b = get_input("Parameter b in °C", 22.0, float)
    
    print("\nHinweis: A bezeichnet die Hüllfläche (Wände+Dach+...), nicht die Wohnfläche!")
    print("Faustformel: Hüllfläche ≈ 2 bis 3 mal Wohnfläche.")
    area = get_input("Hüllfläche des Gebäudes (A) in m^2", 100.0, float)
    u_val = get_input("Wärmedurchgangskoeffizient (U) in W/m^2*K", 0.5, float)
    
    # Location (Default Hamburg)
    lat, lon = get_location_input()
    
    print(f"\nRufe Wetterdaten ab für Zeitraum {datum_start} bis {datum_end}...")
    
    # 2. Fetch Data
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": datum_start.isoformat(),
        "end_date": datum_end.isoformat(),
        "hourly": "temperature_2m"
    }
    
    try:
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        print(f"Fehler: Konnte Wetterdaten nicht abrufen. {e}")
        return

    hourly_temps = data.get("hourly", {}).get("temperature_2m", [])
    
    if not hourly_temps:
        print("Fehler: Keine Daten vom Wetterdienst erhalten.")
        return

    # 3. Calculation
    total_heat_demand_wh = 0.0
    total_elec_energy_wh = 0.0
    hours_calculated = 0
    
    print(f"\nBerechnung läuft für {len(hourly_temps)} Stunden...")

    for temp_aussen in hourly_temps:
        if temp_aussen is None:
            continue
            
        # Heizlast Q (Leistung in Watt)
        # Q = U * A * (Ti - Ta)
        # Nur heizen, wenn draußen kälter als drinnen
        if temp_aussen < temp_innen:
            q_load_w = u_val * area * (temp_innen - temp_aussen)
            
            # Heizkurve: Vorlauftemperatur
            temp_vorlauf = a * (temp_innen - temp_aussen) + b
            
            # Kelvin Conversion
            t_vorlauf_k = temp_vorlauf + 273.15
            t_aussen_k = temp_aussen + 273.15
            
            # Carnot COP = T_hot / (T_hot - T_cold)
            # T_hot = Vorlauf, T_cold = Aussen
            
            # Physik-Check: Wärmepumpe heizt nur sinnvoll, wenn Vorlauf > Aussen
            if t_vorlauf_k <= t_aussen_k:
                # Fallback: Wenn Vorlauf <= Aussen (z.B. durch Parameter a > 0),
                # ist der Carnot-COP mathematisch unendlich oder negativ (unmöglich).
                # Wir setzen hier eine Warnung oder nehmen COP=1 als "Heizstab" an?
                # Annahme für Programm: Sehr uneffizient oder Fehler -> wir begrenzen.
                # Um Division durch Null zu vermeiden:
                cop_carnot = 99999.0 # Praktisch unendlich effizient (keine Arbeit nötig)
            else:
                 cop_carnot = t_vorlauf_k / (t_vorlauf_k - t_aussen_k)
            
            # Realer COP
            cop_real = eff * cop_carnot
            
            # Begrenzung nach unten (Heizstab = 1.0) um realistische Werte zu halten?
            # User Input war rein "eff". 
            if cop_real < 1.0:
                 cop_real = 1.0
                 
            # Elektrische Leistung für diese Stunde
            if cop_real > 20000: # Catch infinity
                 p_elec_w = 0.0 
            else:
                 p_elec_w = q_load_w / cop_real
            
            total_heat_demand_wh += q_load_w
            total_elec_energy_wh += p_elec_w
            hours_calculated += 1
            
    # Ergebnisse
    if hours_calculated == 0:
        print("Keine Heizstunden im Zeitraum (Draußen war es immer wärmer als drinnen).")
        return

    # Wh -> kWh
    heat_kwh = total_heat_demand_wh / 1000.0
    elec_kwh = total_elec_energy_wh / 1000.0
    
    if elec_kwh > 0:
        jaz = heat_kwh / elec_kwh
    else:
        jaz = 0.0

    print("\n--- Zusammenfassung ---")
    print(f"Gesamte Stunden im Zeitraum: {len(hourly_temps)}")
    print(f"Davon Heizstunden: {hours_calculated}")
    print(f"Gesamt Heizwärmebedarf: {heat_kwh:.2f} kWh")
    print(f"Erwarteter Stromverbrauch: {elec_kwh:.2f} kWh")
    print(f"Jahresarbeitszahl (COP über Zeitraum): {jaz:.2f}")

    if a == -1.0 and b == 20.0 and temp_innen == 20.0:
        print("\nHinweis: Mit den gewählten Parametern (a=-1, b=20, Ti=20) ergibt die Heizkurve")
        print("eine Vorlauftemperatur gleich der Außentemperatur. Dies führt theoretisch")
        print("zu unendlichem COP (JAZ steigt stark), da keine Temperaturdifferenz gepumpt wird.")
        print("Für realistische Szenarien wählen Sie z.B. a = 1.")

if __name__ == "__main__":
    main()
