import React from "react";
import ReactDOM from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter} from "react-router-dom";
import "antd/dist/reset.css";
import "./style.css";
import {App} from "./ui";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider
    client={new QueryClient()}><BrowserRouter><App/></BrowserRouter></QueryClientProvider></React.StrictMode>);
