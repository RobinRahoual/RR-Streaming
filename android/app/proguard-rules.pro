# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class fr.robinrahoual.rrstreaming.**$$serializer { *; }
-keepclassmembers class fr.robinrahoual.rrstreaming.** { *** Companion; }
-keepclasseswithmembers class fr.robinrahoual.rrstreaming.** { kotlinx.serialization.KSerializer serializer(...); }
# NanoHTTPD
-keep class fi.iki.elonen.** { *; }
