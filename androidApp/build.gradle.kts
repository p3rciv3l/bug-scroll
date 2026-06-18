import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.github.terrakok.wikwok.androidApp"
    compileSdk = 37

    defaultConfig {
        minSdk = 23
        targetSdk = 37

        applicationId = "com.github.terrakok.wikwok.androidApp"
        versionCode = 5
        versionName = "1.0.4"
    }

    signingConfigs {
        if (properties.contains("key.file")) {
            create("release") {
                storeFile = file(properties["key.file"] as String)
                storePassword = properties["key.pwd"] as String
                keyAlias = properties["key.alias"] as String
                keyPassword = properties["key.alias.pwd"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"
            )
            if (properties.contains("key.file")) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    //https://android.izzysoft.de/articles/named/iod-scan-apkchecks#blobs
    dependenciesInfo {
        // Disables dependency metadata when building APKs.
        includeInApk = false
        // Disables dependency metadata when building Android App Bundles.
        includeInBundle = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":sharedUI"))
    implementation(libs.androidx.activityCompose)
}
