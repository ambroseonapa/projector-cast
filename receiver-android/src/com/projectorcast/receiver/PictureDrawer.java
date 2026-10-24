package com.projectorcast.receiver;

import android.opengl.GLES20;

import org.webrtc.CustomShaderDrawer;
import org.webrtc.GlRectDrawer;
import org.webrtc.GlShader;
import org.webrtc.RendererCommon;

/**
 * Draws video frames with brightness, contrast, colour and sharpness applied on the GPU. With all
 * settings at 0 it uses the library's standard drawer, so the default picture path is unchanged.
 * Settings are read on the render thread for every frame.
 */
class PictureDrawer implements RendererCommon.GlDrawer {

    // Each -50..50, sharpness 0..100.
    private volatile int brightness, contrast, colour, sharpness;

    private static final String SHADER = "uniform float brightness;\n"
            + "uniform float contrast;\n"
            + "uniform float saturation;\n"
            + "uniform float sharpness;\n"
            + "uniform vec2 texel;\n"
            + "void main() {\n"
            + "  vec3 c = sample(tc).rgb;\n"
            + "  if (sharpness > 0.0) {\n"
            + "    vec3 around = sample(tc + vec2(texel.x, 0.0)).rgb + sample(tc - vec2(texel.x, 0.0)).rgb\n"
            + "        + sample(tc + vec2(0.0, texel.y)).rgb + sample(tc - vec2(0.0, texel.y)).rgb;\n"
            + "    c += (c - around * 0.25) * sharpness;\n"
            + "  }\n"
            + "  c = (c - 0.5) * contrast + 0.5 + brightness;\n"
            + "  c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, saturation);\n"
            + "  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);\n"
            + "}\n";

    private final GlRectDrawer plain = new GlRectDrawer();
    private CustomShaderDrawer adjusted;
    private boolean shaderFailed;

    private final CustomShaderDrawer.Uniforms uniforms = new CustomShaderDrawer.Uniforms() {
        private int uBrightness, uContrast, uSaturation, uSharpness, uTexel;

        public void onNewShader(GlShader shader) {
            uBrightness = shader.getUniformLocation("brightness");
            uContrast = shader.getUniformLocation("contrast");
            uSaturation = shader.getUniformLocation("saturation");
            uSharpness = shader.getUniformLocation("sharpness");
            uTexel = shader.getUniformLocation("texel");
        }

        public void onPrepareShader(GlShader shader, int frameWidth, int frameHeight) {
            GLES20.glUniform1f(uBrightness, brightness / 250f);
            GLES20.glUniform1f(uContrast, 1 + contrast / 100f);
            GLES20.glUniform1f(uSaturation, 1 + colour / 50f);
            GLES20.glUniform1f(uSharpness, sharpness / 66f);
            GLES20.glUniform2f(uTexel, 1f / Math.max(1, frameWidth), 1f / Math.max(1, frameHeight));
        }
    };

    void set(int brightness, int contrast, int colour, int sharpness) {
        this.brightness = brightness;
        this.contrast = contrast;
        this.colour = colour;
        this.sharpness = sharpness;
    }

    /** True if the adjusted picture could not be drawn on this GPU (the plain one is used instead). */
    boolean failed() { return shaderFailed; }

    private RendererCommon.GlDrawer pick() {
        if (shaderFailed || (brightness == 0 && contrast == 0 && colour == 0 && sharpness == 0)) return plain;
        if (adjusted == null) adjusted = new CustomShaderDrawer(SHADER, uniforms);
        return adjusted;
    }

    public void drawOes(int tex, float[] m, int fw, int fh, int x, int y, int w, int h) {
        RendererCommon.GlDrawer d = pick();
        try {
            d.drawOes(tex, m, fw, fh, x, y, w, h);
        } catch (RuntimeException e) {
            fallBack(d, e);
            plain.drawOes(tex, m, fw, fh, x, y, w, h);
        }
    }

    public void drawRgb(int tex, float[] m, int fw, int fh, int x, int y, int w, int h) {
        RendererCommon.GlDrawer d = pick();
        try {
            d.drawRgb(tex, m, fw, fh, x, y, w, h);
        } catch (RuntimeException e) {
            fallBack(d, e);
            plain.drawRgb(tex, m, fw, fh, x, y, w, h);
        }
    }

    public void drawYuv(int[] tex, float[] m, int fw, int fh, int x, int y, int w, int h) {
        RendererCommon.GlDrawer d = pick();
        try {
            d.drawYuv(tex, m, fw, fh, x, y, w, h);
        } catch (RuntimeException e) {
            fallBack(d, e);
            plain.drawYuv(tex, m, fw, fh, x, y, w, h);
        }
    }

    /** A shader that does not compile on this GPU: keep showing the picture without adjustments. */
    private void fallBack(RendererCommon.GlDrawer d, RuntimeException e) {
        if (d == plain) throw e;
        shaderFailed = true;
        try { adjusted.release(); } catch (RuntimeException ignored) { }
        adjusted = null;
    }

    public void release() {
        plain.release();
        if (adjusted != null) adjusted.release();
        adjusted = null;
    }
}
