pipeline {
  agent any

  tools {
        nodejs 'npm'
    }

  environment {
    DOCKER_IMAGE = "digimaya-backend:${env.BUILD_ID}"
    SONAR_PROJECT_KEY = 'DigiMaya'
    SONAR_PROJECT_NAME = 'DigiMaya'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Install dependencies') {
      steps {
        sh 'npm ci'
      }
    }

    stage('npm audit') {
      steps {
        sh 'npm audit --audit-level=moderate || true'
      }
    }

    stage('Trivy scan (repo filesystem)') {
      steps {
        sh 'trivy fs --severity CRITICAL,HIGH .'
      }
    }

    stage('Build Docker image') {
      steps {
        sh 'docker build -t ${DOCKER_IMAGE} .'
      }
    }

    stage('Trivy scan (docker image)') {
      steps {
        sh 'trivy image --severity CRITICAL,HIGH ${DOCKER_IMAGE}'
      }
    }

    stage('SonarQube scan') {
      when {
        expression { return env.SONAR_HOST_URL && env.SONAR_TOKEN }
      }
      steps {
        sh '''
          sonar-scanner \
            -Dsonar.projectKey=${SONAR_PROJECT_KEY} \
            -Dsonar.projectName=${SONAR_PROJECT_NAME} \
            -Dsonar.host.url=${SONAR_HOST_URL} \
            -Dsonar.login=${SONAR_TOKEN}
        '''
      }
    }
  }

  post {
    always {
      echo 'Pipeline completed.'
    }
  }
}
