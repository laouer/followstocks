"""
Configuration constants and environment variables for the FollowStocks application.
"""
import os
import re
from pathlib import Path
from typing import Any

# Environment variables
AUTO_REFRESH_SECONDS = int(os.getenv("AUTO_REFRESH_SECONDS", "300"))
AUTO_REFRESH_ENABLED = os.getenv("AUTO_REFRESH_ENABLED", "true").lower() not in {"0", "false", "no"}
CAC40_CACHE_TTL_SECONDS = int(os.getenv("CAC40_CACHE_TTL_SECONDS", "1800"))
SBF120_CACHE_TTL_SECONDS = int(os.getenv("SBF120_CACHE_TTL_SECONDS", "1800"))

_raw_cors_allow_origins = os.getenv(
    "CORS_ALLOW_ORIGINS",
    "http://localhost:5173,http://localhost:4173",
)


def _parse_cors_allow_origins(raw_value: str) -> list[str]:
    """
    Parse origins from comma/newline/space-separated values and normalize them.
    """
    entries = [part.strip() for part in re.split(r"[\s,]+", raw_value or "") if part.strip()]
    normalized: list[str] = []
    for origin in entries:
        if origin == "*":
            normalized.append(origin)
            continue
        normalized.append(origin.rstrip("/"))
    if not normalized:
        return ["http://localhost:5173", "http://localhost:4173"]
    return normalized


CORS_ALLOW_ORIGINS = _parse_cors_allow_origins(_raw_cors_allow_origins)
CORS_ALLOW_ALL_ORIGINS = "*" in CORS_ALLOW_ORIGINS

# Price tracker constants
PRICE_TRACKER_YAHOO = "yahoo"
PRICE_TRACKER_BOURSORAMA = "boursorama"
PRICE_TRACKERS = {PRICE_TRACKER_YAHOO, PRICE_TRACKER_BOURSORAMA}
BOURSORAMA_QUOTE_URL = "https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts"
BOURSORAMA_LOGIN_URL = os.getenv(
    "BOURSORAMA_LOGIN_URL",
    "https://clients.boursobank.com/connexion/",
)
BOURSORAMA_IDENTIFIER = os.getenv(
    "BOURSORAMA_IDENTIFIER",
    os.getenv("BOURSORAMA_LOGIN", ""),
).strip()
BOURSORAMA_STORAGE_DIR = os.getenv(
    "BOURSORAMA_STORAGE_DIR",
    str(Path(__file__).resolve().parents[2] / "private" / "boursorama"),
)
YFINANCE_UNREACHABLE_MESSAGE = (
    "Last prices are not updated because Yahoo Finance is unreachable "
    "(connection lost or blocked)."
)

# CAC40 ticker list
CAC40_TICKERS = [
    {"symbol": "AC.PA", "name": "Accor"},
    {"symbol": "AI.PA", "name": "Air Liquide"},
    {"symbol": "AIR.PA", "name": "Airbus"},
    {"symbol": "ALO.PA", "name": "Alstom"},
    {"symbol": "MT.AS", "name": "ArcelorMittal"},
    {"symbol": "CS.PA", "name": "AXA"},
    {"symbol": "BNP.PA", "name": "BNP Paribas"},
    {"symbol": "EN.PA", "name": "Bouygues"},
    {"symbol": "CAP.PA", "name": "Capgemini"},
    {"symbol": "CA.PA", "name": "Carrefour"},
    {"symbol": "ACA.PA", "name": "Credit Agricole"},
    {"symbol": "BN.PA", "name": "Danone"},
    {"symbol": "DSY.PA", "name": "Dassault Systemes"},
    {"symbol": "EDEN.PA", "name": "Edenred"},
    {"symbol": "ENGI.PA", "name": "Engie"},
    {"symbol": "EL.PA", "name": "EssilorLuxottica"},
    {"symbol": "RMS.PA", "name": "Hermes"},
    {"symbol": "KER.PA", "name": "Kering"},
    {"symbol": "OR.PA", "name": "L'Oreal"},
    {"symbol": "LR.PA", "name": "Legrand"},
    {"symbol": "MC.PA", "name": "LVMH"},
    {"symbol": "ML.PA", "name": "Michelin"},
    {"symbol": "ORA.PA", "name": "Orange"},
    {"symbol": "RI.PA", "name": "Pernod Ricard"},
    {"symbol": "PUB.PA", "name": "Publicis"},
    {"symbol": "RNO.PA", "name": "Renault"},
    {"symbol": "SAF.PA", "name": "Safran"},
    {"symbol": "SGO.PA", "name": "Saint-Gobain"},
    {"symbol": "SAN.PA", "name": "Sanofi"},
    {"symbol": "SU.PA", "name": "Schneider Electric"},
    {"symbol": "GLE.PA", "name": "Societe Generale"},
    {"symbol": "STLAP.PA", "name": "Stellantis"},
    {"symbol": "STMPA.PA", "name": "STMicroelectronics"},
    {"symbol": "TTE.PA", "name": "TotalEnergies"},
    {"symbol": "URW.AS", "name": "Unibail-Rodamco-Westfield"},
    {"symbol": "VIE.PA", "name": "Veolia"},
    {"symbol": "DG.PA", "name": "Vinci"},
    {"symbol": "VIV.PA", "name": "Vivendi"},
    {"symbol": "WLN.PA", "name": "Worldline"},
    {"symbol": "HO.PA", "name": "Thales"},
]

# CAC40 analysis metrics
CAC40_METRICS = {
    "analyst_discount": "Analyst discount",
    "pe_discount": "P/E discount",
    "sector_pe_discount": "Sector P/E discount",
    "dividend_yield": "Dividend yield",
    "composite": "Composite score",
}

# SBF120 extra tickers (beyond CAC40)
SBF120_EXTRA_TICKERS = [
    {"symbol": "ADP.PA", "name": "Aeroports de Paris"},
    {"symbol": "AF.PA", "name": "Air France-KLM"},
    {"symbol": "AKE.PA", "name": "Arkema"},
    {"symbol": "AYV.PA", "name": "Ayvens"},
    {"symbol": "ATO.PA", "name": "Atos"},
    {"symbol": "BEN.PA", "name": "Beneteau"},
    {"symbol": "BIM.PA", "name": "bioMerieux"},
    {"symbol": "BOL.PA", "name": "Bollore"},
    {"symbol": "BVI.PA", "name": "Bureau Veritas"},
    {"symbol": "CARM.PA", "name": "Carmila"},
    {"symbol": "CDA.PA", "name": "Compagnie des Alpes"},
    {"symbol": "COFA.PA", "name": "Coface"},
    {"symbol": "COV.PA", "name": "Covivio"},
    {"symbol": "DBG.PA", "name": "Derichebourg"},
    {"symbol": "DEC.PA", "name": "JCDecaux"},
    {"symbol": "EDF.PA", "name": "EDF"},
    {"symbol": "ELIOR.PA", "name": "Elior"},
    {"symbol": "ELIS.PA", "name": "Elis"},
    {"symbol": "ENX.PA", "name": "Euronext"},
    {"symbol": "ERA.PA", "name": "Eramet"},
    {"symbol": "ERF.PA", "name": "Eurofins Scientific"},
    {"symbol": "ETL.PA", "name": "Eutelsat"},
    {"symbol": "EXHO.PA", "name": "Sodexo"},
    {"symbol": "FDJU.PA", "name": "FDJ United"},
    {"symbol": "FGR.PA", "name": "Eiffage"},
    {"symbol": "FR.PA", "name": "Valeo"},
    {"symbol": "GFC.PA", "name": "Gecina"},
    {"symbol": "GET.PA", "name": "Getlink"},
    {"symbol": "GTT.PA", "name": "Gaztransport & Technigaz"},
    {"symbol": "IPN.PA", "name": "Ipsen"},
    {"symbol": "LI.PA", "name": "Klepierre"},
    {"symbol": "MAU.PA", "name": "Maurel et Prom"},
    {"symbol": "MRN.PA", "name": "Mersen"},
    {"symbol": "NEX.PA", "name": "Nexans"},
    {"symbol": "NK.PA", "name": "Imerys"},
    {"symbol": "POM.PA", "name": "OPmobility"},
    {"symbol": "RCO.PA", "name": "Remy Cointreau"},
    {"symbol": "RF.PA", "name": "Eurazeo"},
    {"symbol": "RUI.PA", "name": "Rubis"},
    {"symbol": "RXL.PA", "name": "Rexel"},
    {"symbol": "SCR.PA", "name": "SCOR"},
    {"symbol": "SESL.PA", "name": "SES-imagotag"},
    {"symbol": "SK.PA", "name": "SEB"},
    {"symbol": "SMCP.PA", "name": "SMCP"},
    {"symbol": "SOI.PA", "name": "Soitec"},
    {"symbol": "SOP.PA", "name": "Sopra Steria"},
    {"symbol": "SPIE.PA", "name": "SPIE"},
    {"symbol": "TEP.PA", "name": "Teleperformance"},
    {"symbol": "TFI.PA", "name": "TF1"},
    {"symbol": "TKTT.PA", "name": "Tarkett"},
    {"symbol": "TRI.PA", "name": "Trigano"},
    {"symbol": "UBI.PA", "name": "Ubisoft"},
    {"symbol": "VCT.PA", "name": "Vicat"},
    {"symbol": "VIRP.PA", "name": "Virbac"},
    {"symbol": "VK.PA", "name": "Vallourec"},
    {"symbol": "VLA.PA", "name": "Valneva"},
]
