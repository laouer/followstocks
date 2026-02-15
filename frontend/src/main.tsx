import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import Bsf120Analysis from "./Bsf120Analysis";
import Cac40Analysis from "./Cac40Analysis";
import AssuranceVieSimulator from "./AssuranceVieSimulator";
import CompteATermeSimulator from "./CompteATermeSimulator";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/analysis/cac40" element={<Cac40Analysis />} />
        <Route path="/analysis/bsf120" element={<Bsf120Analysis />} />
        <Route path="/simulate/assurance-vie" element={<AssuranceVieSimulator />} />
        <Route path="/simulate/compte-a-terme" element={<CompteATermeSimulator />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
