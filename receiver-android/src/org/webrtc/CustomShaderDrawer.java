package org.webrtc;

/** Public access to the library's GlGenericDrawer (package-private) with a custom fragment shader. */
public class CustomShaderDrawer extends GlGenericDrawer {

    public interface Uniforms {
        void onNewShader(GlShader shader);

        void onPrepareShader(GlShader shader, int frameWidth, int frameHeight);
    }

    public CustomShaderDrawer(String fragmentShader, final Uniforms uniforms) {
        super(fragmentShader, new ShaderCallbacks() {
            @Override
            public void onNewShader(GlShader shader) { uniforms.onNewShader(shader); }

            @Override
            public void onPrepareShader(GlShader shader, float[] texMatrix, int frameWidth, int frameHeight,
                    int viewportWidth, int viewportHeight) {
                uniforms.onPrepareShader(shader, frameWidth, frameHeight);
            }
        });
    }
}
