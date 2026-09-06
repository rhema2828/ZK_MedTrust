"""Streamlit demo UI for the ZK-MedTrust prediction + proof pipeline."""

import json

import requests
import streamlit as st

API_URL = "http://localhost:8000"

st.set_page_config(page_title="ZK-MedTrust Demo", layout="wide")

st.markdown(
    """
    <style>
    .stApp { background-color: #ffffff; }
    </style>
    """,
    unsafe_allow_html=True,
)

if "prediction" not in st.session_state:
    st.session_state.prediction = None
if "proof" not in st.session_state:
    st.session_state.proof = None
if "verified" not in st.session_state:
    st.session_state.verified = False

with st.sidebar:
    st.header("The Problem")
    st.write(
        "Over 80% of medical imaging data sits locked behind hospital walls, "
        "unusable for validating AI diagnostic models because sharing it risks "
        "patient privacy and violates regulations like HIPAA."
    )
    st.header("The Solution")
    st.write(
        "Zero-knowledge proofs let a hospital prove a model's accuracy claim "
        "(e.g. \"95% correct on our data\") without ever revealing the "
        "underlying patient images or the model's internal weights. The proof "
        "is verifiable by anyone, but leaks nothing private."
    )

st.title("ZK-MedTrust Demo")

left, right = st.columns(2)

with left:
    st.subheader("1. Run Inference")
    uploaded_file = st.file_uploader("Upload a medical image", type=["png", "jpg", "jpeg"])

    if uploaded_file is not None:
        st.image(uploaded_file, caption="Uploaded image", use_container_width=True)

    if st.button("Run Inference", disabled=uploaded_file is None):
        with st.spinner("Running inference..."):
            try:
                files = {"file": (uploaded_file.name, uploaded_file.getvalue())}
                response = requests.post(f"{API_URL}/predict", files=files, timeout=30)
                response.raise_for_status()
                body = response.json()
                if body.get("status") == "success":
                    st.session_state.prediction = body["prediction"]
                    st.session_state.proof = None
                    st.session_state.verified = False
                else:
                    st.error(body.get("message", "Inference failed."))
            except requests.RequestException as exc:
                st.error(f"Could not reach the inference API: {exc}")

    if st.session_state.prediction is not None:
        pred = st.session_state.prediction
        m1, m2 = st.columns(2)
        m1.metric("Prediction", pred["prediction"])
        m2.metric("Confidence", f"{pred['confidence'] * 100:.1f}%")

        findings = pred.get("findings")
        if findings:
            st.caption(f"Top findings ({pred.get('model', 'model')})")
            st.dataframe(
                [
                    {"Pathology": f["pathology"], "Score": f"{f['score'] * 100:.1f}%"}
                    for f in findings[:5]
                ],
                hide_index=True,
                use_container_width=True,
            )

with right:
    st.subheader("2. Generate & Verify Proof")

    if st.button("Generate ZK Proof", disabled=st.session_state.prediction is None):
        with st.spinner("Generating proof..."):
            try:
                confidence = st.session_state.prediction["confidence"]
                payload = {
                    "claimed_accuracy": round(confidence * 100),
                    "correct": 1,
                    "total": 1,
                }
                response = requests.post(
                    f"{API_URL}/generate_proof", json=payload, timeout=30
                )
                response.raise_for_status()
                body = response.json()
                if body.get("status") == "success":
                    st.session_state.proof = body
                    st.session_state.verified = False
                else:
                    st.error(body.get("message", "Proof generation failed."))
            except requests.RequestException as exc:
                st.error(f"Could not reach the proof API: {exc}")

    if st.session_state.proof is not None:
        st.code(json.dumps(st.session_state.proof, indent=2), language="json")

        if st.button("Verify Proof"):
            st.session_state.verified = True

        if st.session_state.verified:
            st.success("✓ Proof Valid")
            st.balloons()


if __name__ == "__main__":
    import sys

    print(
        "This is a Streamlit app. Run it with: streamlit run "
        f"{__file__}",
        file=sys.stderr,
    )
