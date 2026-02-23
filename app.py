import os

import gradio as gr
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from api.productivity_routes import router as productivity_router
from api.routes import router
from ui.gradio_app import create_gradio_app


def create_app() -> FastAPI:
    app = FastAPI(title="agent_test Productivity Agent", version="2.0.0")
    app.include_router(router)
    app.include_router(productivity_router)

    gradio_app = create_gradio_app()
    app = gr.mount_gradio_app(app, gradio_app, path="/")
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    default_port = "7860" if os.getenv("SPACE_ID") else "5001"
    port = int(os.getenv("PORT", default_port))
    uvicorn.run("app:app", host=host, port=port, reload=False)
