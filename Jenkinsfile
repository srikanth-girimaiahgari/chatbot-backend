pipeline {
  agent any

  tools {
        nodejs 'npm'
    }

  environment {
    DOCKER_IMAGE = "digimaya-backend:${env.BUILD_NUMBER}"
    SONAR_PROJECT_KEY = 'DigiMaya'
    SONAR_PROJECT_NAME = 'DigiMaya'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }
    
    stage('Debug Environment') {
    steps {
        sh '''
        echo "===== BASIC INFO ====="
        whoami
        pwd
        hostname

        echo "===== OS INFO ====="
        cat /etc/os-release || true
        uname -a

        echo "===== PATH ====="
        echo $PATH

        echo "===== NODE LOCATION ====="
        which node || true

        echo "===== NODE LINKAGE ====="
        ldd $(which node) || true

        echo "===== LIB CHECK ====="
        ls -l /usr/lib*/libatomic* || true
        ls -l /lib*/libatomic* || true
        '''
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
