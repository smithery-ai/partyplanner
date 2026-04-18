import { QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"

import { queryClient } from "./lib/query"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
