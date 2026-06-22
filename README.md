# 🛰️ **PhytoLens** – Geospatial Remote Sensing Analytics Engine

**PhytoLens** is a production-grade remote sensing web application built with a **React (Vite) Frontend** and a **Python FastAPI Backend** leveraging the **Microsoft Planetary Computer (MPC)** STAC API for dynamic satellite data extraction. It enables researchers, GIS engineers, and environmental scientists to process, analyze, and export multi-sensor earth observation data through a premium dark-themed scientific HUD dashboard.

---

## 📋 **Overview & Architecture**

The application is split into two components:
1. **Frontend (`/frontend`)**: A high-fidelity React dashboard styled as a scientific HUD. Pinned with a Leaflet map that supports coordinate acquisitions, base map toggling (Esri Satellite vs OpenStreetMap), and raster layer overlays.
2. **Backend (`/backend`)**: A FastAPI server that queries Microsoft Planetary Computer STAC endpoints, streams and clips Cloud-Optimized GeoTIFFs (COGs) on-the-fly using `rasterio`.

---

## 🎯 **Core Capabilities**

- **🔍 Spectral Monitor**:
  - Optical & Thermal indices: NDVI, GNDVI, NDWI, NDMI, LST (Surface Temperature).
  - Satellites: Sentinel-2 (L2A), Landsat 8/9 (C2 L2), Sentinel-1 (Radar).
  - Dynamic visual stretching (2nd to 98th percentile contrast stretching).
  - Custom algebraic band math expressions (e.g. `(B8 - B4) / (B8 + B4)`).

- **🤖 AlphaEarth Foundation AI (AEF)**:
  - **AI Clustering**: Unsupervised segmentation of multi-temporal embeddings into $K$ user-defined clusters to identify crop performance or land cover transitions.
  - **AI Similarity Search**: Compare user-drawn or uploaded multi-geometry queries against target ROIs using 64-dimensional embeddings (cosine similarity).
  - **Local Contrast Mode**: Optional mean-centering of embeddings to rank distinct features accurately across varying or uniform terrain.

- **🗺️ Intuitive Polygon Drawing**:
  - Click-to-close capability by clicking on the starting vertex marker or within a 15-pixel screen-distance tolerance of it.
  - Immersive full-screen feel with drawing status toasts and zero top-panel HUD clutter.

- **💾 Data Export**:
  - Instant raw GeoTIFF exports.
  - Transparent PNG maps for web-map overlay.

---

## 🚀 **Quick Start**

### **Prerequisites**
- Python 3.9+
- Node.js (v18+) & npm

### **1. Set up the Backend**
From the root directory:
```bash
# Install dependencies
python -m pip install -r backend/requirements.txt

# Run the FastAPI server
python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```
*The backend API will run at `http://127.0.0.1:8000`.*

### **2. Set up the Frontend**
Open a new terminal and run:
```bash
# Navigate to frontend folder
cd frontend

# Install package dependencies
npm install

# Run the Vite React client
npm run dev
```
*Open your browser and navigate to `http://127.0.0.1:5173` to access the application dashboard.*

### **3. Run Automated Tests**
You can verify the STAC query and raster calculations programmatically:
```bash
python backend/verify.py
```

---

## 📂 **Project Structure**

```
PhytoLens/
├── backend/
│   ├── app.py             # FastAPI main routes
│   ├── pc_handler.py      # STAC query, band extraction, and index calculation
│   ├── verify.py          # Programmatic test script
│   └── requirements.txt   # Python backend dependencies
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main React dashboard layout, Leaflet maps, and widgets
│   │   ├── index.css      # Core styles (Scientific HUD theme, custom inputs)
│   │   └── main.jsx       # Vite app mounting
│   ├── index.html         # HTML entry point (SEO configured)
│   └── package.json       # React dependencies (Leaflet, Lucide Icons)
└── README.md              # Documentation
```

---

## 🎨 **Visual Design Theme**

- **Dark HUD Cyberpunk Aesthetic**: High-contrast, glowing neon color indicators (Cyan for UI, Green for Active Uplink, Red/Amber for Hazard warnings).
- **Glassmorphic Cards**: Sleek panels with blurred backdrops and subtle borders.
- **Interactive Map**: Quick basemap switching between high-res satellite telemetry and standard streets layout, with coordinate sync overlays.

---

**Made with ❤️ by Nitesh Kumar | GIS Engineer**
