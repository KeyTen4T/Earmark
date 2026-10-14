# Consumer ProGuard rules for the local earmark-surround module.
#
# The JNI entry points are declared `external` in Kotlin and looked up by name at runtime, so the
# class and its methods must survive shrinking.
-keep class app.earmark.surround.** { *; }
#
# SurroundRenderersFactory is instantiated by expo-audio via Class.forName + getConstructor(Context),
# which R8 cannot see. Keep the class and its (Context) constructor explicitly.
-keep class app.earmark.surround.SurroundRenderersFactory {
    public <init>(android.content.Context);
}
#
# The bundled aften encoder is plain C reached only through the native library, so it needs no
# rules.
